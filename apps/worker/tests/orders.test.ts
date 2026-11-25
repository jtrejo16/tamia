import { notificationSettings, orderItemModifiers, orderItems, orders, tenants } from "@empleado/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createOrderNotifier, createOrderScanner } from "../src/processors/orders";
import { dropWorld, makeWorld, openDbs, type Dbs, type World } from "./helpers";

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

const EMAIL = { apiKey: "k", fromEmail: "avisos@jovia.test", fromName: "Jovia" };

async function setup(opts: { enabled?: boolean; recipients?: Array<{ id: string; kind: "whatsapp" | "email"; address: string; enabled: boolean }> } = {}) {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  const { db } = dbs.owner;
  await db.update(tenants).set({ name: "Taquería Don Pepe" }).where(eq(tenants.id, w.tenantId));
  await db.insert(notificationSettings).values({
    tenantId: w.tenantId,
    enabled: opts.enabled ?? true,
    mode: "always",
    recipients: opts.recipients ?? [{ id: "r1", kind: "email", address: "cocina@taqueria.test", enabled: true }, { id: "r2", kind: "whatsapp", address: "+529991234567", enabled: true }],
  });
  const [o] = await db
    .insert(orders)
    .values({ tenantId: w.tenantId, number: 7, contactId: w.contactId, conversationId: w.conversationId, channel: "whatsapp", customerName: "Laura", customerPhone: "+529991234568", paymentMethod: "efectivo", subtotalCents: 5700, totalCents: 5700, notes: "Paso en 20 min" })
    .returning();
  const [line] = await db.insert(orderItems).values({ tenantId: w.tenantId, orderId: o!.id, name: "Pastor", unitPriceCents: 1800, quantity: 2, lineTotalCents: 4200, notes: "sin cebolla" }).returning();
  await db.insert(orderItemModifiers).values({ tenantId: w.tenantId, orderItemId: line!.id, groupName: "Tortilla", optionName: "Harina", priceDeltaCents: 300 });
  const sendEmail = vi.fn(async () => {});
  const deps = { db: dbs.app.db, email: EMAIL as typeof EMAIL | null, sendEmail, baseUrl: "https://app.jovia.test/" };
  const row = async () => (await dbs.owner.db.select().from(orders).where(eq(orders.id, o!.id)))[0]!;
  return { w, o: o!, sendEmail, deps, row, job: { tenantId: w.tenantId, orderId: o!.id } };
}

describe("aviso de pedido nuevo al equipo", () => {
  it("manda un correo con el cliente, las partidas, el total y el enlace al tablero; y solo una vez", async () => {
    const t = await setup();
    expect(await createOrderNotifier(t.deps)(t.job)).toEqual({ status: "sent", email: 1 });
    expect(t.sendEmail).toHaveBeenCalledTimes(1);
    const [, mail] = t.sendEmail.mock.calls[0] as unknown as [unknown, { to: string; subject: string; text: string }];
    expect(mail.to).toBe("cocina@taqueria.test");
    expect(mail.subject).toBe("Pedido #7 · Laura · $57 MXN");
    expect(mail.text).toContain("2 × Pastor (Tortilla: Harina) — sin cebolla");
    expect(mail.text).toContain("Taquería Don Pepe");
    expect(mail.text).toContain("Nota: Paso en 20 min");
    expect(mail.text).toContain("https://app.jovia.test/pedidos");
    expect((await t.row()).notifiedAt).not.toBeNull();
    expect(await createOrderNotifier(t.deps)(t.job)).toEqual({ status: "skipped", reason: "already" });
    expect(t.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("sin destinatario de correo o con los avisos apagados no manda nada ni marca el pedido", async () => {
    const onlyWa = await setup({ recipients: [{ id: "r2", kind: "whatsapp", address: "+529991234567", enabled: true }] });
    expect(await createOrderNotifier(onlyWa.deps)(onlyWa.job)).toEqual({ status: "skipped", reason: "no_email" });
    expect((await onlyWa.row()).notifiedAt).toBeNull();
    const off = await setup({ enabled: false });
    expect(await createOrderNotifier(off.deps)(off.job)).toMatchObject({ status: "skipped" });
    const noService = await setup();
    expect(await createOrderNotifier({ ...noService.deps, email: null })(noService.job)).toEqual({ status: "skipped", reason: "no_email" });
    expect(noService.sendEmail).not.toHaveBeenCalled();
  });

  it("si el envio falla se libera para reintentar y cuenta el intento", async () => {
    const t = await setup();
    t.sendEmail.mockRejectedValueOnce(new Error("brevo caido"));
    expect(await createOrderNotifier(t.deps)(t.job)).toEqual({ status: "failed" });
    const r = await t.row();
    expect(r.notifiedAt).toBeNull();
    expect(r.notifyAttempts).toBe(1);
    expect(await createOrderNotifier(t.deps)(t.job)).toEqual({ status: "sent", email: 1 });
  });

  it("el barrido avisa de los pedidos nuevos y no de los que ya se atendieron", async () => {
    const t = await setup();
    const other = await setup();
    await dbs.owner.db.update(orders).set({ status: "preparing" }).where(eq(orders.id, other.o.id));
    const scan = createOrderScanner(t.deps);
    const r = await scan();
    expect(r.errors).toBe(0);
    expect((await t.row()).notifiedAt).not.toBeNull();
    expect((await other.row()).notifiedAt).toBeNull();
  });
});

describe("aviso de pedido a domicilio", () => {
  it("el correo dice A DOMICILIO con la direccion, la zona, el envio y el total", async () => {
    const t = await setup();
    await dbs.owner.db.update(orders).set({ mode: "delivery", deliveryAddress: "Calle 60 #123, casa azul", deliveryZoneName: "Centro", deliveryFeeCents: 3000, totalCents: 8700 }).where(eq(orders.id, t.o.id));
    expect(await createOrderNotifier(t.deps)(t.job)).toEqual({ status: "sent", email: 1 });
    const [, mail] = t.sendEmail.mock.calls[0] as unknown as [unknown, { subject: string; text: string }];
    expect(mail.subject).toBe("Pedido #7 · Laura · $87 MXN");
    expect(mail.text).toContain("A DOMICILIO");
    expect(mail.text).toContain("Entregar en: Calle 60 #123, casa azul, col. Centro");
    expect(mail.text).toContain("Envío: $30 MXN");
    expect(mail.text).toContain("Total: $87 MXN");
    expect(mail.text).not.toContain("Para recoger en el local");
  });
});
