import { WhatsAppApiError } from "@empleado/channels";
import { channels, messages } from "@empleado/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noLock } from "../src/lock";
import { createOutboundProcessor } from "../src/processors/outbound";
import { sweepStaleMessages } from "../src/outbox";
import { FakeSender, KEY, NOW, dropWorld, makeWorld, openDbs, queueMessage, type Dbs, type World } from "./helpers";

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

async function setup(options: Parameters<typeof makeWorld>[1] = {}) {
  const w = await makeWorld(dbs.owner, options);
  worlds.push(w);
  const sender = new FakeSender();
  const made: Array<{ accessToken: string; phoneNumberId: string }> = [];
  const process = createOutboundProcessor({
    db: dbs.app.db,
    key: KEY,
    makeSender: (access) => {
      made.push(access);
      return sender;
    },
    lock: noLock,
    now: () => NOW,
  });
  const get = async (id: string) => (await dbs.owner.db.select().from(messages).where(eq(messages.id, id)))[0]!;
  return { w, sender, made, process, get };
}

const apiError = (kind: ConstructorParameters<typeof WhatsAppApiError>[1]["kind"], code?: number) =>
  new WhatsAppApiError(`fallo ${kind}`, { kind, code, status: 400 });

describe("procesador de envios", () => {
  it("envia el texto a la API de WhatsApp, guarda el wamid y marca 'sent'", async () => {
    const { w, sender, made, process, get } = await setup();
    const m = await queueMessage(dbs.owner, w, { body: "Hola Carlos" });
    const result = await process({ tenantId: w.tenantId, messageId: m.id });

    expect(result).toMatchObject({ status: "processed", sent: [m.id], failed: [] });
    expect(sender.calls).toEqual([{ kind: "text", to: w.waId, body: "Hola Carlos" }]);
    expect(made[0]).toEqual({ accessToken: "EAAG-token-de-prueba", phoneNumberId: w.phoneNumberId });
    const row = await get(m.id);
    expect(row.status).toBe("sent");
    expect(row.externalId).toMatch(/^wamid\.OUT/);
  });

  it("es idempotente: un segundo intento no vuelve a enviar", async () => {
    const { w, sender, process } = await setup();
    const m = await queueMessage(dbs.owner, w, { body: "Una sola vez" });
    await process({ tenantId: w.tenantId, messageId: m.id });
    const again = await process({ tenantId: w.tenantId, messageId: m.id });
    expect(again).toEqual({ status: "skipped", reason: "already_processed" });
    expect(sender.calls).toHaveLength(1);
  });

  it("envia en orden: el texto antes que la ubicacion, aunque el trabajo sea el de la ubicacion", async () => {
    const { w, sender, process } = await setup();
    const t0 = new Date(Date.now() - 5000);
    const text = await queueMessage(dbs.owner, w, { body: "Aquí estamos.", createdAt: t0 });
    const loc = await queueMessage(dbs.owner, w, {
      type: "location",
      body: JSON.stringify({ name: "Clínica", address: "Calle 60", latitude: 20.96, longitude: -89.62 }),
      createdAt: t0,
    });
    const result = await process({ tenantId: w.tenantId, messageId: loc.id });
    expect(result).toMatchObject({ sent: [text.id, loc.id] });
    expect(sender.calls.map((c) => c.kind)).toEqual(["text", "location"]);
    expect(sender.calls[1]!.location).toMatchObject({ latitude: 20.96, name: "Clínica" });

    // El trabajo del texto, que llega despues, ya no encuentra nada que enviar.
    expect(await process({ tenantId: w.tenantId, messageId: text.id })).toMatchObject({ status: "skipped" });
    expect(sender.calls).toHaveLength(2);
  });

  it("una ubicacion sin coordenadas se manda como texto con direccion y mapa", async () => {
    const { w, sender, process } = await setup();
    const m = await queueMessage(dbs.owner, w, {
      type: "location",
      body: JSON.stringify({ name: "Clínica", address: "Calle 60", mapsUrl: "https://maps.example/x" }),
    });
    await process({ tenantId: w.tenantId, messageId: m.id });
    expect(sender.calls[0]).toMatchObject({ kind: "text", body: "Clínica\nCalle 60\nhttps://maps.example/x" });
  });

  it("fuera de la ventana de 24 h NO envia texto libre y lo marca como fallido", async () => {
    const { w, sender, process, get } = await setup({ lastInboundAt: new Date(NOW.getTime() - 25 * 3600_000) });
    const m = await queueMessage(dbs.owner, w, { body: "Recordatorio" });
    const result = await process({ tenantId: w.tenantId, messageId: m.id });
    expect(result).toMatchObject({ sent: [], failed: [m.id] });
    expect(sender.calls).toHaveLength(0);
    expect((await get(m.id)).error).toContain("fuera_de_ventana_24h");
  });

  it("sin token guardado en el canal, falla de forma clara (no se intenta enviar)", async () => {
    const { w, sender, process, get } = await setup({ withCredentials: false });
    const m = await queueMessage(dbs.owner, w, { body: "Hola" });
    await process({ tenantId: w.tenantId, messageId: m.id });
    expect(sender.calls).toHaveLength(0);
    expect((await get(m.id)).error).toContain("sin_credenciales");
  });

  it("un destinatario invalido o no autorizado falla sin reintentos", async () => {
    const { w, sender, process, get } = await setup();
    sender.beforeSend = () => {
      throw apiError("recipient", 131030);
    };
    const m = await queueMessage(dbs.owner, w, { body: "Hola" });
    const result = await process({ tenantId: w.tenantId, messageId: m.id }, { attempt: 1, maxAttempts: 5 });
    expect(result).toMatchObject({ failed: [m.id] });
    const row = await get(m.id);
    expect(row.status).toBe("failed");
    expect(row.error).toContain("recipient");
  });

  it("un token vencido marca el mensaje como fallido Y el canal en error", async () => {
    const { w, sender, process, get } = await setup();
    sender.beforeSend = () => {
      throw apiError("auth", 190);
    };
    const m = await queueMessage(dbs.owner, w, { body: "Hola" });
    await process({ tenantId: w.tenantId, messageId: m.id });
    expect((await get(m.id)).status).toBe("failed");
    const [channel] = await dbs.owner.db.select().from(channels).where(eq(channels.id, w.channelId));
    expect(channel!.status).toBe("error");
  });

  it("un fallo transitorio se relanza para que BullMQ reintente y el mensaje sigue en cola", async () => {
    const { w, sender, process, get } = await setup();
    sender.beforeSend = () => {
      throw apiError("rate", 130429);
    };
    const m = await queueMessage(dbs.owner, w, { body: "Hola" });
    await expect(process({ tenantId: w.tenantId, messageId: m.id }, { attempt: 1, maxAttempts: 5 })).rejects.toBeInstanceOf(WhatsAppApiError);
    expect((await get(m.id)).status).toBe("queued");

    // Al reintentar con exito, se envia.
    sender.beforeSend = () => {};
    await process({ tenantId: w.tenantId, messageId: m.id }, { attempt: 2, maxAttempts: 5 });
    expect((await get(m.id)).status).toBe("sent");
  });

  it("al agotar los reintentos el mensaje queda 'failed' (si no, el barrido lo reintentaria para siempre)", async () => {
    const { w, sender, process, get } = await setup();
    sender.beforeSend = () => {
      throw apiError("server");
    };
    const m = await queueMessage(dbs.owner, w, { body: "Hola" });
    const result = await process({ tenantId: w.tenantId, messageId: m.id }, { attempt: 5, maxAttempts: 5 });
    expect(result).toMatchObject({ failed: [m.id] });
    const row = await get(m.id);
    expect(row.status).toBe("failed");
    expect(row.error).toContain("reintentos_agotados");
  });

  it("ignora mensajes que no existen o son entrantes", async () => {
    const { w, process } = await setup();
    expect(await process({ tenantId: w.tenantId, messageId: "00000000-0000-4000-8000-000000000000" })).toEqual({
      status: "skipped",
      reason: "not_found",
    });
  });

  it("un trabajador de OTRO negocio no puede enviar el mensaje (aislamiento)", async () => {
    const a = await setup();
    const b = await setup();
    const m = await queueMessage(dbs.owner, a.w, { body: "Privado de A" });
    const result = await b.process({ tenantId: b.w.tenantId, messageId: m.id });
    expect(result).toEqual({ status: "skipped", reason: "not_found" });
    expect(b.sender.calls).toHaveLength(0);
  });
});

describe("barrido de recuperacion", () => {
  it("re-encola mensajes que llevan tiempo en cola y deja los recientes", async () => {
    const { w } = await setup();
    const old = await queueMessage(dbs.owner, w, { body: "viejo", createdAt: new Date(Date.now() - 10 * 60_000) });
    const fresh = await queueMessage(dbs.owner, w, { body: "reciente" });
    const sent: Array<{ tenantId: string; messageId: string }> = [];
    await sweepStaleMessages(dbs.app.db, async (j) => void sent.push(j), 60, 100_000);
    const mine = sent.filter((s) => s.tenantId === w.tenantId).map((s) => s.messageId);
    expect(mine).toContain(old.id);
    expect(mine).not.toContain(fresh.id);
  });
});
