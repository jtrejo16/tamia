import { ensureConversation } from "@empleado/agent";
import { sealChannelCredentials, type InboundJobData } from "@empleado/channels";
import { channels, contactIdentities, contacts, conversations, messages } from "@empleado/db";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noLock } from "../src/lock";
import { createInboundProcessor } from "../src/processors/inbound";
import { createOutboundProcessor } from "../src/processors/outbound";
import { unlimited } from "../src/ratelimit";
import { FakeLLM, FakeSender, KEY, NOW, dropWorld, makeWorld, openDbs, type Dbs, type Step, type World } from "./helpers";

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

type Kind = "messenger" | "instagram";
const psid = () => String(Math.floor(5e15 + Math.random() * 1e15));

/** Un negocio de WhatsApp al que se le agrega ademas un canal de Messenger o Instagram con su clave. */
async function setup(kind: Kind = "messenger", steps?: Step[]) {
  const w = await makeWorld(dbs.owner, { lastInboundAt: null });
  worlds.push(w);
  const channelId = randomUUID();
  const accountId = String(Math.floor(1e14 + Math.random() * 9e14));
  await dbs.owner.db.insert(channels).values({
    id: channelId,
    tenantId: w.tenantId,
    type: kind,
    externalId: accountId,
    credentialsEnc: sealChannelCredentials({ accessToken: "PAGE-TOKEN" }, KEY, w.tenantId, channelId),
  });
  const llm = new FakeLLM(steps);
  const enqueued: Array<{ tenantId: string; messageId: string }> = [];
  const inbound = createInboundProcessor({
    db: dbs.app.db,
    llm,
    enqueueOutbound: async (j) => void enqueued.push(j),
    lock: noLock,
    limiter: unlimited,
    now: () => NOW,
  });
  const job = (from: string, text: string, id = `m_${Math.random().toString(36).slice(2)}`, over: Partial<InboundJobData> = {}): InboundJobData => ({
    tenantId: w.tenantId,
    channelId,
    channelType: kind,
    phoneNumberId: accountId,
    message: { id, from, timestamp: 1767225600, type: "text", text },
    ...over,
  });
  const sender = new FakeSender();
  const made: Array<{ accessToken: string; phoneNumberId: string; channelType: string }> = [];
  const outbound = createOutboundProcessor({
    db: dbs.app.db,
    key: KEY,
    makeSender: (access) => {
      made.push(access);
      return sender;
    },
    lock: noLock,
    now: () => NOW,
  });
  return { w, channelId, accountId, llm, enqueued, inbound, outbound, job, sender, made };
}

const identitiesOf = (tenantId: string) => dbs.owner.db.select().from(contactIdentities).where(eq(contactIdentities.tenantId, tenantId));

describe("mensajes entrantes de Messenger / Instagram", () => {
  for (const kind of ["messenger", "instagram"] as const) {
    it(`${kind}: un cliente nuevo SIN telefono recibe contacto, identidad y conversacion en ese canal, y el asistente responde`, async () => {
      const { w, channelId, inbound, job, llm, enqueued } = await setup(kind, [{ text: "¡Hola! ¿En qué te ayudo?" }]);
      const id = psid();
      const result = await inbound(job(id, "Hola, quiero una cita", "m_1", { contactName: "Ana IG" }));
      expect(result).toMatchObject({ status: "processed", action: "send" });
      expect(llm.requests).toHaveLength(1);
      expect(enqueued).toHaveLength(1);

      const [identity] = await identitiesOf(w.tenantId);
      expect(identity).toMatchObject({ channelType: kind, channelId, externalId: id });
      const [contact] = await dbs.owner.db.select().from(contacts).where(eq(contacts.id, identity!.contactId));
      expect(contact!.phoneE164).toBeNull();
      expect(contact!.profile).toMatchObject({ [`${kind}_name`]: "Ana IG" });

      const [conversation] = await dbs.owner.db.select().from(conversations).where(eq(conversations.contactId, contact!.id));
      expect(conversation!.channelId).toBe(channelId);
      const rows = await dbs.owner.db.select().from(messages).where(eq(messages.conversationId, conversation!.id));
      expect(rows.map((r) => [r.direction, r.body, r.channelId])).toEqual(
        expect.arrayContaining([["in", "Hola, quiero una cita", channelId], ["out", "¡Hola! ¿En qué te ayudo?", channelId]]),
      );
    });
  }

  it("el mismo cliente que vuelve a escribir conserva SU contacto y conversacion (no se duplica)", async () => {
    const { w, inbound, job } = await setup("messenger", [{ text: "ok" }]);
    const id = psid();
    await inbound(job(id, "uno", "m_a"));
    await inbound(job(id, "dos", "m_b"));
    expect(await identitiesOf(w.tenantId)).toHaveLength(1);
    const convs = await dbs.owner.db.select().from(conversations).where(eq(conversations.tenantId, w.tenantId));
    // la conversacion de WhatsApp del mundo de prueba + UNA de Messenger
    expect(convs.filter((c) => c.channelId !== w.channelId)).toHaveLength(1);
  });

  it("dos clientes distintos son contactos distintos, y el cliente de Messenger NO se mezcla con el de WhatsApp", async () => {
    const { w, inbound, job } = await setup("messenger", [{ text: "ok" }]);
    await inbound(job(psid(), "hola", "m_1"));
    await inbound(job(psid(), "hola", "m_2"));
    expect(await identitiesOf(w.tenantId)).toHaveLength(2);
    const [wa] = await dbs.owner.db.select().from(contacts).where(eq(contacts.id, w.contactId));
    expect(wa!.phoneE164).toBe(w.phone);
  });

  it("un mensaje repetido (reintento de Meta) no genera una segunda respuesta", async () => {
    const { inbound, job, enqueued } = await setup("instagram", [{ text: "ok" }]);
    const id = psid();
    await inbound(job(id, "hola", "m_same"));
    const again = await inbound(job(id, "hola", "m_same"));
    expect(again).toMatchObject({ action: "none", reason: "duplicate" });
    expect(enqueued).toHaveLength(1);
  });

  it("la respuesta sale SIN marcas de WhatsApp (*negrita*, **markdown**): estas redes mostrarian los asteriscos", async () => {
    const { w, inbound, job } = await setup("instagram", [{ text: "Tenemos **limpieza** a *$600* y # Extras" }]);
    await inbound(job(psid(), "precios?", "m_p"));
    const [out] = await dbs.owner.db
      .select()
      .from(messages)
      .where(and(eq(messages.tenantId, w.tenantId), eq(messages.direction, "out")));
    expect(out!.body).toBe("Tenemos limpieza a $600 y # Extras");
  });

  it("el agente sabe que NO tiene el telefono y que debe pedirlo antes de agendar", async () => {
    const { inbound, job, llm } = await setup("instagram", [{ text: "ok" }]);
    await inbound(job(psid(), "hola", "m_t"));
    const system = String(llm.requests[0]!.messages[0]!.content);
    expect(system).toContain("AÚN NO LO TIENES");
    expect(system).toContain("Instagram");
  });

  it("guardar el telefono que da el cliente: se normaliza a E.164 y queda en el MISMO contacto", async () => {
    const steps: Step[] = [{ tools: [{ name: "guardar_datos_contacto", args: { telefono: "998 123 4567" } }] }, { text: "Gracias" }];
    const { w, inbound, job } = await setup("messenger", steps);
    const id = psid();
    await inbound(job(id, "mi numero es 998 123 4567", "m_ph"));
    const [identity] = (await identitiesOf(w.tenantId))!;
    const [contact] = await dbs.owner.db.select().from(contacts).where(eq(contacts.id, identity!.contactId));
    expect(contact!.phoneE164).toBe("+529981234567");
  });

  it("si ese telefono ya es de OTRO cliente NO se fusionan: no se hereda su historial ni sus datos", async () => {
    const steps: Step[] = [{ tools: [{ name: "guardar_datos_contacto", args: { telefono: "" } }] }, { text: "ok" }];
    // el telefono del cliente de WhatsApp del mundo de prueba, sin lada: 10 digitos
    const { w, inbound, job } = await setup("instagram", steps);
    const ten = w.waId.slice(-10);
    steps[0] = { tools: [{ name: "guardar_datos_contacto", args: { telefono: ten } }] };
    const id = psid();
    await inbound(job(id, `mi numero es ${ten}`, "m_dup"));

    const [identity] = (await identitiesOf(w.tenantId))!;
    const [mine] = await dbs.owner.db.select().from(contacts).where(eq(contacts.id, identity!.contactId));
    expect(mine!.phoneE164).toBeNull(); // no se le asigno
    expect(mine!.id).not.toBe(w.contactId);
    const [original] = await dbs.owner.db.select().from(contacts).where(eq(contacts.id, w.contactId));
    expect(original!.phoneE164).toBe(w.phone); // el otro cliente queda intacto
  });
});

describe("envio por Messenger / Instagram", () => {
  async function conversationFor(kind: Kind) {
    const s = await setup(kind);
    const id = psid();
    const ref = await ensureConversation(dbs.app.db, { tenantId: s.w.tenantId, channelId: s.channelId, identity: { externalId: id } });
    await dbs.owner.db.update(conversations).set({ lastInboundAt: NOW }).where(eq(conversations.id, ref.conversationId));
    const queue = async (type: "text" | "template", body: string) =>
      (
        await dbs.owner.db
          .insert(messages)
          .values({ tenantId: s.w.tenantId, conversationId: ref.conversationId, channelId: s.channelId, direction: "out", sender: "bot", type, body, status: "queued" })
          .returning()
      )[0]!;
    const get = async (mid: string) => (await dbs.owner.db.select().from(messages).where(eq(messages.id, mid)))[0]!;
    return { ...s, id, ref, queue, get };
  }

  it("envia al id del cliente (no a un telefono) con el cliente de ESE canal y la clave de la pagina", async () => {
    const c = await conversationFor("instagram");
    const m = await c.queue("text", "Hola desde la clínica");
    expect(await c.outbound({ tenantId: c.w.tenantId, messageId: m.id })).toMatchObject({ sent: [m.id], failed: [] });
    expect(c.sender.calls).toEqual([{ kind: "text", to: c.id, body: "Hola desde la clínica" }]);
    expect(c.made[0]).toEqual({ accessToken: "PAGE-TOKEN", phoneNumberId: c.accountId, channelType: "instagram" });
    expect((await c.get(m.id)).status).toBe("sent");
  });

  it("una plantilla (recordatorio) NO se manda por estas redes: falla con motivo claro y no toca a Meta", async () => {
    const c = await conversationFor("messenger");
    const m = await c.queue("template", JSON.stringify({ name: "x", language: "es_MX", params: [], text: "t" }));
    await c.outbound({ tenantId: c.w.tenantId, messageId: m.id });
    expect(c.sender.calls).toHaveLength(0);
    expect(await c.get(m.id)).toMatchObject({ status: "failed" });
    expect((await c.get(m.id)).error).toContain("plantilla_no_soportada");
  });

  it("fuera de la ventana de 24 h no se escribe (igual que en WhatsApp)", async () => {
    const c = await conversationFor("messenger");
    await dbs.owner.db.update(conversations).set({ lastInboundAt: new Date(NOW.getTime() - 25 * 3600_000) }).where(eq(conversations.id, c.ref.conversationId));
    const m = await c.queue("text", "tarde");
    await c.outbound({ tenantId: c.w.tenantId, messageId: m.id });
    expect(c.sender.calls).toHaveLength(0);
    expect((await c.get(m.id)).error).toContain("fuera_de_ventana_24h");
  });

  it("un contacto sin identidad en ese canal no se intenta enviar (queda fallido, no se manda a un numero equivocado)", async () => {
    const c = await conversationFor("messenger");
    await dbs.owner.db.delete(contactIdentities).where(eq(contactIdentities.tenantId, c.w.tenantId));
    const m = await c.queue("text", "hola");
    await c.outbound({ tenantId: c.w.tenantId, messageId: m.id });
    expect(c.sender.calls).toHaveLength(0);
    expect((await c.get(m.id)).error).toContain("sin_identidad");
  });
});
