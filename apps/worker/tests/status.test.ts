import type { StatusEvent } from "@empleado/channels";
import { messages } from "@empleado/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MessageNotFoundYet, createStatusProcessor } from "../src/processors/status";
import { dropWorld, makeWorld, openDbs, queueMessage, type Dbs, type World } from "./helpers";

let dbs: Dbs;
let w: World;
beforeAll(async () => {
  dbs = openDbs();
  w = await makeWorld(dbs.owner);
});
afterAll(async () => {
  await dropWorld(dbs.owner, w);
  await dbs.app.close();
  await dbs.owner.close();
});

const process = () => createStatusProcessor({ db: dbs.app.db });
const status = (id: string, s: StatusEvent["status"], extra: Partial<StatusEvent> = {}) => ({
  tenantId: w.tenantId,
  channelId: w.channelId,
  status: { id, status: s, timestamp: 1, ...extra },
});

async function sentMessage(wamid: string) {
  const m = await queueMessage(dbs.owner, w, { body: "x" });
  await dbs.owner.db.update(messages).set({ status: "sent", externalId: wamid }).where(eq(messages.id, m.id));
  return m.id;
}
const statusOf = async (id: string) => (await dbs.owner.db.select().from(messages).where(eq(messages.id, id)))[0]!;

describe("avisos de entrega", () => {
  it("avanza sent -> delivered -> read", async () => {
    const id = await sentMessage("wamid.S1");
    expect(await process()(status("wamid.S1", "delivered"))).toEqual({ status: "updated", to: "delivered" });
    expect((await statusOf(id)).status).toBe("delivered");
    expect(await process()(status("wamid.S1", "read"))).toEqual({ status: "updated", to: "read" });
    expect((await statusOf(id)).status).toBe("read");
  });

  it("un aviso tardio nunca retrocede el estado (delivered despues de read)", async () => {
    const id = await sentMessage("wamid.S2");
    await process()(status("wamid.S2", "read"));
    expect(await process()(status("wamid.S2", "delivered"))).toEqual({ status: "unchanged" });
    expect((await statusOf(id)).status).toBe("read");
  });

  it("guarda como cobra Meta el mensaje (categoria y si se cobra), tambien si el estado ya no avanza", async () => {
    const id = await sentMessage("wamid.P1");
    await process()(status("wamid.P1", "read")); // ya leido, sin dato de cobro
    expect((await statusOf(id)).pricingCategory).toBeNull();
    // El aviso "sent" llega tarde (ya no cambia el estado) pero trae el cobro: se guarda igual.
    expect(await process()(status("wamid.P1", "sent", { pricing: { billable: true, category: "service", type: "regular" } }))).toEqual({ status: "unchanged" });
    expect(await statusOf(id)).toMatchObject({ status: "read", pricingCategory: "service", billable: true });

    const free = await sentMessage("wamid.P2");
    await process()(status("wamid.P2", "delivered", { pricing: { billable: false, category: "service", type: "free_customer_service" } }));
    expect(await statusOf(free)).toMatchObject({ status: "delivered", pricingCategory: "service", billable: false });
  });

  it("registra el motivo cuando WhatsApp reporta un fallo", async () => {
    const id = await sentMessage("wamid.S3");
    await process()(status("wamid.S3", "failed", { errorCode: 131047, errorTitle: "Re-engagement message" }));
    const row = await statusOf(id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("131047: Re-engagement message");
  });

  it("un 'failed' tardio no pisa un mensaje que ya fue leido", async () => {
    const id = await sentMessage("wamid.S4");
    await process()(status("wamid.S4", "read"));
    expect(await process()(status("wamid.S4", "failed", { errorCode: 1 }))).toEqual({ status: "unchanged" });
    expect((await statusOf(id)).status).toBe("read");
  });

  it("si el mensaje aun no esta guardado, lanza para reintentar (el aviso puede llegar antes)", async () => {
    await expect(process()(status("wamid.AUN-NO-EXISTE", "delivered"))).rejects.toBeInstanceOf(MessageNotFoundYet);
  });

  it("no mezcla negocios: un aviso del canal de otro negocio no toca este mensaje", async () => {
    const id = await sentMessage("wamid.S5");
    const other = await makeWorld(dbs.owner);
    try {
      await expect(
        createStatusProcessor({ db: dbs.app.db })({
          tenantId: other.tenantId,
          channelId: other.channelId,
          status: { id: "wamid.S5", status: "read", timestamp: 1 },
        }),
      ).rejects.toBeInstanceOf(MessageNotFoundYet);
      expect((await statusOf(id)).status).toBe("sent");
    } finally {
      await dropWorld(dbs.owner, other);
    }
  });
});
