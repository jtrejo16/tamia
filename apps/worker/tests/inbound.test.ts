import type { InboundJobData } from "@empleado/channels";
import { contacts, conversations, messages } from "@empleado/db";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { noLock } from "../src/lock";
import { createInboundProcessor } from "../src/processors/inbound";
import { unlimited } from "../src/ratelimit";
import { FakeLLM, NOW, dropWorld, makeWorld, openDbs, type Dbs, type World, type Step } from "./helpers";

let dbs: Dbs;
const worlds: World[] = [];
beforeAll(() => {
  dbs = openDbs();
});
afterAll(async () => {
  for (const w of worlds) await dropWorld(dbs.owner, w);
  await dbs.app.close();
  await dbs.owner.close();
});

async function setup(steps?: Step[], limiter = unlimited) {
  const w = await makeWorld(dbs.owner, { lastInboundAt: null });
  worlds.push(w);
  const llm = new FakeLLM(steps);
  const enqueued: Array<{ tenantId: string; messageId: string }> = [];
  const process = createInboundProcessor({
    db: dbs.app.db,
    llm,
    enqueueOutbound: async (job) => void enqueued.push(job),
    lock: noLock,
    limiter,
    now: () => NOW,
  });
  const job = (over: Partial<InboundJobData["message"]> = {}, extra: Partial<InboundJobData> = {}): InboundJobData => ({
    tenantId: w.tenantId,
    channelId: w.channelId,
    phoneNumberId: w.phoneNumberId,
    contactName: "Ana",
    message: { id: `wamid.${Math.random().toString(36).slice(2)}`, from: w.waId, timestamp: 1767225600, type: "text", text: "Hola", ...over },
    ...extra,
  });
  return { w, llm, enqueued, process, job };
}

describe("procesador de mensajes entrantes", () => {
  it("atiende el mensaje, guarda la conversacion y encola el envio de la respuesta", async () => {
    const { w, llm, enqueued, process, job } = await setup([{ text: "¡Hola! Soy Sonri." }]);
    const result = await process(job({ id: "wamid.PRIMERO", text: "Hola, buenas tardes" }));

    expect(result).toMatchObject({ status: "processed", action: "send" });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.tenantId).toBe(w.tenantId);

    // El cliente (ya existente) conserva su conversacion y se guarda el apodo de WhatsApp.
    const [contact] = await dbs.owner.db.select().from(contacts).where(eq(contacts.id, w.contactId));
    expect((contact!.profile as Record<string, unknown>).whatsapp_name).toBe("Ana");

    const rows = await dbs.owner.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, w.conversationId))
      .orderBy(asc(messages.createdAt));
    expect(rows.map((r) => [r.direction, r.body, r.status])).toEqual([
      ["in", "Hola, buenas tardes", "received"],
      ["out", "¡Hola! Soy Sonri.", "queued"],
    ]);
    expect(rows[0]!.externalId).toBe("wamid.PRIMERO");
    expect(llm.requests).toHaveLength(1);
  });

  it("crea el contacto y la conversacion de un cliente NUEVO en el canal correcto", async () => {
    const { w, process, job } = await setup();
    const result = await process(job({ from: "5219990001111" }, { contactName: "Beto" }));
    expect(result.status).toBe("processed");

    const [contact] = await dbs.owner.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.tenantId, w.tenantId), eq(contacts.phoneE164, "+5219990001111")));
    expect(contact).toBeTruthy();
    expect((contact!.profile as Record<string, unknown>).whatsapp_name).toBe("Beto");
    expect(contact!.displayName).toBeNull(); // el apodo NO se toma como nombre real

    const [conv] = await dbs.owner.db.select().from(conversations).where(eq(conversations.contactId, contact!.id));
    expect(conv!.channelId).toBe(w.channelId);
    expect(conv!.lastInboundAt).toBeTruthy();
  });

  it("un mensaje repetido (reintento de Meta) no genera una segunda respuesta", async () => {
    const { llm, enqueued, process, job } = await setup();
    const same = job({ id: "wamid.REPETIDO" });
    await process(same);
    const again = await process(same);
    expect(again).toMatchObject({ status: "processed", action: "none", reason: "duplicate", queued: [] });
    expect(llm.requests).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
  });

  it("el limite por cliente corta antes de gastar IA", async () => {
    const limiter = { allow: vi.fn().mockResolvedValue(false) };
    const { llm, enqueued, process, job, w } = await setup(undefined, limiter);
    const result = await process(job({ from: "5219990002222" }));
    expect(result).toEqual({ status: "skipped", reason: "rate_limited" });
    expect(llm.requests).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
    const rows = await dbs.owner.db.select().from(contacts).where(and(eq(contacts.tenantId, w.tenantId), eq(contacts.phoneE164, "+5219990002222")));
    expect(rows).toHaveLength(0);
    expect(limiter.allow).toHaveBeenCalledWith(`inbound:${w.tenantId}:5219990002222`, 30, 3600);
  });

  it("si una persona tiene el control, guarda el mensaje pero el asistente no responde", async () => {
    const { w, llm, enqueued, process, job } = await setup();
    await dbs.owner.db.update(conversations).set({ state: "human" }).where(eq(conversations.id, w.conversationId));
    const result = await process(job({ text: "¿hay alguien?" }));
    expect(result).toMatchObject({ status: "processed", action: "none", reason: "human_has_control" });
    expect(llm.requests).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
    const inbound = await dbs.owner.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, w.conversationId), eq(messages.direction, "in")));
    expect(inbound).toHaveLength(1);
  });

  it("una imagen sin leyenda llega al agente como aviso y guarda la referencia al archivo", async () => {
    const { w, llm, process, job } = await setup();
    await process(job({ id: "wamid.IMG", type: "image", text: "", mediaId: "MEDIA123", mimeType: "image/jpeg" }));
    const [row] = await dbs.owner.db.select().from(messages).where(and(eq(messages.conversationId, w.conversationId), eq(messages.externalId, "wamid.IMG")));
    expect(row).toMatchObject({ type: "image", mediaUrl: "wa-media:MEDIA123" });
    const lastUser = llm.requests[0]!.messages.filter((m) => m.role === "user").at(-1);
    expect(lastUser!.content).toContain("imagen");
  });

  it("una nota de voz se guarda como audio y el agente sabe que no pudo transcribirse", async () => {
    const { w, llm, process, job } = await setup();
    await process(job({ id: "wamid.AUD", type: "audio", text: "", mediaId: "MEDIA9" }));
    const [row] = await dbs.owner.db.select().from(messages).where(and(eq(messages.conversationId, w.conversationId), eq(messages.externalId, "wamid.AUD")));
    expect(row!.type).toBe("audio");
    expect(JSON.stringify(llm.requests[0]!.messages)).toContain("Nota de voz");
  });

  it("si el agente envia la ubicacion, se encolan dos envios y el texto va primero", async () => {
    const { w, enqueued, process, job } = await setup([
      { tools: [{ name: "enviar_ubicacion", args: {} }] },
      { text: "Aquí estamos." },
    ]);
    await process(job({ text: "¿dónde están?" }));
    expect(enqueued).toHaveLength(2);
    const rows = await dbs.owner.db.select().from(messages).where(and(eq(messages.conversationId, w.conversationId), eq(messages.direction, "out")));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.type]));
    expect(enqueued.map((e) => byId[e.messageId])).toEqual(["text", "location"]);
  });

  it("en modo copiloto no encola envios: deja un borrador", async () => {
    const w = await makeWorld(dbs.owner, { autonomy: "copilot", lastInboundAt: null });
    worlds.push(w);
    const enqueued: unknown[] = [];
    const process = createInboundProcessor({
      db: dbs.app.db,
      llm: new FakeLLM(),
      enqueueOutbound: async (j) => void enqueued.push(j),
      lock: noLock,
      limiter: unlimited,
      now: () => NOW,
    });
    const result = await process({
      tenantId: w.tenantId,
      channelId: w.channelId,
      phoneNumberId: w.phoneNumberId,
      message: { id: "wamid.COP", from: w.waId, timestamp: 1, type: "text", text: "Hola" },
    });
    expect(result).toMatchObject({ action: "draft", queued: [] });
    expect(enqueued).toHaveLength(0);
  });
});
