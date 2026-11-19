import { createHmac } from "node:crypto";
import { loadPack } from "@empleado/agent";
import { agentConfigs, auditLog, subscriptions, tenants, users, withTenant } from "@empleado/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MercadoPagoClient,
  cancelSubscription,
  getBilling,
  handleMercadoPagoEvent,
  reconcileSubscriptions,
  operatorChangeComped,
  operatorChangeStatus,
  operatorTenants,
  signup,
  startCheckout,
  VERTICALS,
  tenantAccess,
  verifyMercadoPagoSignature,
  type PanelContext,
} from "../src";
import { openDbs, type Dbs } from "./helpers";

let dbs: Dbs;
const tenantIds: string[] = [];
const userIds: string[] = [];
beforeAll(() => {
  dbs = openDbs();
});
afterAll(async () => {
  for (const id of tenantIds) await dbs.owner.db.delete(tenants).where(eq(tenants.id, id));
  for (const id of userIds) await dbs.owner.db.delete(users).where(eq(users.id, id));
  await dbs.app.close();
  await dbs.owner.close();
});

const unique = () => Math.random().toString(36).slice(2, 10);
const PASS = "Una-contraseña-larga-2027";

async function newBusiness(): Promise<{ ctx: PanelContext; email: string }> {
  const email = `alta-${unique()}@test.local`;
  const res = await signup(dbs.app.db, { businessName: "Clínica Álamo Nueva", vertical: "dental", ownerName: "Ana Pérez", email, password: PASS });
  if (!res.ok) throw new Error(`signup fallo: ${res.error}`);
  tenantIds.push(res.tenantId);
  userIds.push(res.userId);
  return { ctx: { tenantId: res.tenantId, userId: res.userId, role: "owner" }, email };
}

/** Mercado Pago falso: guarda lo que se le manda y responde como la API real. */
function fakeMp(state: { status?: string; next?: string; paymentPreapproval?: string } = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path: u.pathname, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/preapproval" && init?.method === "POST") return json({ id: "pre-" + unique(), status: "pending", init_point: "https://mp.test/checkout/abc" });
    if (u.pathname.startsWith("/preapproval/") && init?.method === "PUT") return json({ id: u.pathname.split("/").pop(), status: body.status });
    if (u.pathname.startsWith("/preapproval/")) return json({ id: u.pathname.split("/").pop(), status: state.status ?? "authorized", next_payment_date: state.next ?? "2027-04-10T00:00:00.000Z" });
    if (u.pathname.startsWith("/authorized_payments/")) return json({ preapproval_id: state.paymentPreapproval });
    return json({ message: "no existe" }, 404);
  }) as typeof fetch;
  return { client: new MercadoPagoClient({ accessToken: "TEST-token", baseUrl: "https://mp.test", fetch: fetchFake }), calls };
}

const subOf = async (tenantId: string) => (await dbs.owner.db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId)))[0]!;

describe("alta (registro publico)", () => {
  it("crea el negocio PENDIENTE, su dueño y 14 dias de prueba; el asistente NO responde todavia", async () => {
    const { ctx, email } = await newBusiness();
    const [t] = await dbs.owner.db.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
    expect(t).toMatchObject({ status: "pending", plan: "esencial", vertical: "dental" });
    expect(t!.slug).toMatch(/^clinica-alamo-nueva-[0-9a-f]{6}$/);

    const sub = await subOf(ctx.tenantId);
    expect(sub.status).toBe("trialing");
    const trialDays = (sub.trialEndsAt!.getTime() - Date.now()) / 86_400_000;
    expect(trialDays).toBeGreaterThan(13.9);
    expect(trialDays).toBeLessThan(14.1);

    expect((await tenantAccess(dbs.app.db, ctx.tenantId)).reason).toBe("tenant_pending");
    const audit = await dbs.owner.db.select().from(auditLog).where(eq(auditLog.tenantId, ctx.tenantId));
    expect(audit.map((a) => a.action)).toContain("signup");
    expect(email).toContain("@test.local");
  });

  it("un correo que ya tiene cuenta se rechaza SIN tocar esa cuenta", async () => {
    const { ctx, email } = await newBusiness();
    const [before] = await dbs.owner.db.select().from(users).where(eq(users.id, ctx.userId));
    const again = await signup(dbs.app.db, { businessName: "Otra", vertical: "dental", ownerName: "Intruso", email: email.toUpperCase(), password: "Otra-contraseña-larga-1" });
    expect(again).toEqual({ ok: false, error: "email_taken" });
    const [after] = await dbs.owner.db.select().from(users).where(eq(users.id, ctx.userId));
    expect(after!.passwordHash).toBe(before!.passwordHash);
    expect(after!.name).toBe("Ana Pérez");
  });

  it("valida los datos y exige contraseña fuerte", async () => {
    const base = { businessName: "X Clínica", vertical: "dental", ownerName: "Ana", email: `v-${unique()}@test.local`, password: PASS };
    expect(await signup(dbs.app.db, { ...base, businessName: "" })).toMatchObject({ ok: false, error: "invalid" });
    expect(await signup(dbs.app.db, { ...base, email: "no-es-correo" })).toMatchObject({ ok: false, error: "invalid" });
    expect(await signup(dbs.app.db, { ...base, vertical: "otro" })).toMatchObject({ ok: false, error: "invalid" });
    expect(await signup(dbs.app.db, { ...base, vertical: "" })).toMatchObject({ ok: false, error: "invalid" });
    expect(await signup(dbs.app.db, { ...base, timezone: "Marte/Olimpo" })).toMatchObject({ ok: false, error: "invalid" });
    expect(await signup(dbs.app.db, { ...base, password: "corta" })).toEqual({ ok: false, error: "weak_password" });
  });
});

describe("la suscripcion no se puede manipular desde la aplicacion", () => {
  it("el rol de la app puede LEER la suya pero no modificarla ni crear otra", async () => {
    const { ctx } = await newBusiness();
    const mine = await withTenant(dbs.app.db, { tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
      tx.select().from(subscriptions),
    );
    expect(mine).toHaveLength(1);

    await expect(
      withTenant(dbs.app.db, { tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
        tx.update(subscriptions).set({ status: "comped" }).where(eq(subscriptions.tenantId, ctx.tenantId)),
      ),
    ).rejects.toThrow();
    expect((await subOf(ctx.tenantId)).status).toBe("trialing");
  });

  it("un negocio no ve la suscripcion de otro", async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const seen = await withTenant(dbs.app.db, { tenantId: a.ctx.tenantId, userId: a.ctx.userId }, (tx) => tx.select().from(subscriptions));
    expect(seen.map((s) => s.tenantId)).toEqual([a.ctx.tenantId]);
    expect(seen.some((s) => s.tenantId === b.ctx.tenantId)).toBe(false);
  });
});

describe("operador de la plataforma", () => {
  it("un usuario normal NO puede listar ni aprobar negocios", async () => {
    const { ctx } = await newBusiness();
    expect(await operatorTenants(dbs.app.db, ctx.userId)).toEqual({ ok: false, error: "forbidden" });
    expect(await operatorChangeStatus(dbs.app.db, ctx.userId, ctx.tenantId, "active")).toEqual({ ok: false, error: "forbidden" });
    expect(await operatorChangeComped(dbs.app.db, ctx.userId, ctx.tenantId, true)).toEqual({ ok: false, error: "forbidden" });
    const [t] = await dbs.owner.db.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
    expect(t!.status).toBe("pending");
  });

  it("el operador ve todos, aprueba (el asistente se habilita) y deja bitacora", async () => {
    const target = await newBusiness();
    const op = await newBusiness(); // otro usuario cualquiera, que luego se vuelve operador
    await dbs.owner.db.update(users).set({ isOperator: true }).where(eq(users.id, op.ctx.userId));

    const list = await operatorTenants(dbs.app.db, op.ctx.userId);
    if (!list.ok) throw new Error("no deberia fallar");
    const row = list.items.find((r) => r.id === target.ctx.tenantId);
    expect(row).toMatchObject({ status: "pending", subStatus: "trialing", ownerEmail: target.email, channelConnected: false });

    expect(await operatorChangeStatus(dbs.app.db, op.ctx.userId, target.ctx.tenantId, "active")).toEqual({ ok: true });
    expect((await tenantAccess(dbs.app.db, target.ctx.tenantId)).allowed).toBe(true);

    expect(await operatorChangeStatus(dbs.app.db, op.ctx.userId, target.ctx.tenantId, "paused")).toEqual({ ok: true });
    expect((await tenantAccess(dbs.app.db, target.ctx.tenantId)).reason).toBe("tenant_inactive");

    expect(await operatorChangeStatus(dbs.app.db, op.ctx.userId, target.ctx.tenantId, "inventado")).toEqual({ ok: false, error: "invalid" });
    expect(await operatorChangeStatus(dbs.app.db, op.ctx.userId, "00000000-0000-0000-0000-000000000000", "active")).toEqual({ ok: false, error: "not_found" });

    const audit = await dbs.owner.db.select().from(auditLog).where(eq(auditLog.tenantId, target.ctx.tenantId));
    expect(audit.filter((a) => a.action === "operator.set_status")).toHaveLength(2);
  });

  it("cortesia: da acceso sin pago y se puede quitar", async () => {
    const target = await newBusiness();
    const op = await newBusiness();
    await dbs.owner.db.update(users).set({ isOperator: true }).where(eq(users.id, op.ctx.userId));
    await operatorChangeStatus(dbs.app.db, op.ctx.userId, target.ctx.tenantId, "active");
    await dbs.owner.db.update(subscriptions).set({ trialEndsAt: new Date(Date.now() - 10 * 86_400_000) }).where(eq(subscriptions.tenantId, target.ctx.tenantId));
    expect((await tenantAccess(dbs.app.db, target.ctx.tenantId)).reason).toBe("trial_ended");

    expect(await operatorChangeComped(dbs.app.db, op.ctx.userId, target.ctx.tenantId, true)).toEqual({ ok: true });
    expect((await tenantAccess(dbs.app.db, target.ctx.tenantId)).allowed).toBe(true);
    expect(await operatorChangeComped(dbs.app.db, op.ctx.userId, target.ctx.tenantId, false)).toEqual({ ok: true });
    expect((await tenantAccess(dbs.app.db, target.ctx.tenantId)).reason).toBe("trial_ended");
  });
});

describe("cobro con Mercado Pago", () => {
  it("checkout: crea la suscripcion con el primer cobro al terminar la prueba; el plan NO cambia hasta que MP confirme", async () => {
    const { ctx, email } = await newBusiness();
    const { client, calls } = fakeMp();
    const res = await startCheckout(dbs.app.db, ctx, client, { plan: "profesional", payerEmail: email, backUrl: "https://panel.test/facturacion" });
    expect(res).toEqual({ ok: true, url: "https://mp.test/checkout/abc" });

    const create = calls.find((c) => c.method === "POST")!.body as Record<string, any>;
    expect(create.external_reference).toBe(ctx.tenantId);
    expect(create.auto_recurring).toMatchObject({ transaction_amount: 1499, currency_id: "MXN", frequency: 1, frequency_type: "months" });
    expect(create.auto_recurring.start_date).toBe((await subOf(ctx.tenantId)).trialEndsAt!.toISOString());

    const sub = await subOf(ctx.tenantId);
    expect(sub).toMatchObject({ pendingPlan: "profesional", cardAuthorized: false, status: "trialing" });
    expect(sub.mpPreapprovalId).toMatch(/^pre-/);
    const [t] = await dbs.owner.db.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
    expect(t!.plan).toBe("esencial");
  });

  it("solo el dueño inicia el cobro; plan inventado y falta de token se rechazan", async () => {
    const { ctx, email } = await newBusiness();
    const { client } = fakeMp();
    const input = { plan: "profesional", payerEmail: email, backUrl: "https://x" };
    expect(await startCheckout(dbs.app.db, { ...ctx, role: "agent" }, client, input)).toEqual({ ok: false, error: "forbidden" });
    expect(await startCheckout(dbs.app.db, ctx, client, { ...input, plan: "gratis" })).toEqual({ ok: false, error: "invalid_plan" });
    expect(await startCheckout(dbs.app.db, ctx, null, input)).toEqual({ ok: false, error: "payments_unavailable" });
    expect(await cancelSubscription(dbs.app.db, { ...ctx, role: "viewer" }, client)).toEqual({ ok: false, error: "forbidden" });
  });

  it("aviso 'authorized': aplica el plan elegido y marca la tarjeta; el estado se consulta a MP, no al aviso", async () => {
    const { ctx, email } = await newBusiness();
    const { client } = fakeMp({ status: "authorized" });
    await startCheckout(dbs.app.db, ctx, client, { plan: "premium", payerEmail: email, backUrl: "https://x" });
    const pre = (await subOf(ctx.tenantId)).mpPreapprovalId!;

    const result = await handleMercadoPagoEvent(dbs.app.db, client, { type: "subscription_preapproval", dataId: pre });
    expect(result).toEqual({ applied: true });
    const sub = await subOf(ctx.tenantId);
    expect(sub).toMatchObject({ status: "trialing", cardAuthorized: true, pendingPlan: null });
    expect(sub.currentPeriodEnd!.toISOString()).toBe("2027-04-10T00:00:00.000Z");
    const [t] = await dbs.owner.db.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
    expect(t!.plan).toBe("premium");
  });

  it("terminada la prueba, un cobro autorizado la pasa a 'active'; si MP pausa, queda 'past_due'", async () => {
    const { ctx, email } = await newBusiness();
    const state = { status: "authorized", paymentPreapproval: "" };
    const { client } = fakeMp(state);
    await startCheckout(dbs.app.db, ctx, client, { plan: "esencial", payerEmail: email, backUrl: "https://x" });
    const pre = (await subOf(ctx.tenantId)).mpPreapprovalId!;
    state.paymentPreapproval = pre;
    await dbs.owner.db.update(subscriptions).set({ trialEndsAt: new Date(Date.now() - 86_400_000) }).where(eq(subscriptions.tenantId, ctx.tenantId));

    // el aviso de un cobro trae el id del PAGO; se resuelve a la suscripcion consultando a MP
    expect(await handleMercadoPagoEvent(dbs.app.db, client, { type: "subscription_authorized_payment", dataId: "pago-1" })).toEqual({ applied: true });
    expect((await subOf(ctx.tenantId)).status).toBe("active");

    state.status = "paused";
    await handleMercadoPagoEvent(dbs.app.db, client, { type: "subscription_preapproval", dataId: pre });
    expect((await subOf(ctx.tenantId)).status).toBe("past_due");
  });

  it("cancelar: MP lo cancela, queda 'canceled' y el asistente se detiene", async () => {
    const { ctx, email } = await newBusiness();
    const { client, calls } = fakeMp();
    await startCheckout(dbs.app.db, ctx, client, { plan: "esencial", payerEmail: email, backUrl: "https://x" });
    expect(await cancelSubscription(dbs.app.db, ctx, client)).toEqual({ ok: true });
    expect(calls.some((c) => c.method === "PUT" && (c.body as any).status === "cancelled")).toBe(true);
    expect((await subOf(ctx.tenantId)).status).toBe("canceled");
    const bill = await getBilling(dbs.app.db, ctx, true);
    expect(bill.access.reason === "tenant_pending" || bill.access.reason === "canceled").toBe(true);
  });

  it("un aviso de una suscripcion que no es nuestra no cambia nada", async () => {
    const { client } = fakeMp({ status: "authorized" });
    expect(await handleMercadoPagoEvent(dbs.app.db, client, { type: "subscription_preapproval", dataId: "desconocida-123" })).toEqual({ applied: false });
    expect(await handleMercadoPagoEvent(dbs.app.db, client, { type: "payment", dataId: "1" })).toEqual({ applied: false });
  });

  it("un aviso simulado o de un id que Mercado Pago no conoce NO es un error (se responde bien y no se reintenta); una falla real si se propaga", async () => {
    const respond = (status: number) =>
      new MercadoPagoClient({ accessToken: "T", baseUrl: "https://mp.test", fetch: (async () => new Response(JSON.stringify({ message: "x" }), { status })) as typeof fetch });
    expect(await handleMercadoPagoEvent(dbs.app.db, respond(404), { type: "subscription_preapproval", dataId: "123456" })).toEqual({ applied: false });
    expect(await handleMercadoPagoEvent(dbs.app.db, respond(400), { type: "subscription_authorized_payment", dataId: "abc" })).toEqual({ applied: false });
    await expect(handleMercadoPagoEvent(dbs.app.db, respond(503), { type: "subscription_preapproval", dataId: "123456" })).rejects.toThrow();
  });

  it("un negocio de cortesia no cambia por avisos de cobro", async () => {
    const { ctx, email } = await newBusiness();
    const { client } = fakeMp({ status: "cancelled" });
    await startCheckout(dbs.app.db, ctx, client, { plan: "esencial", payerEmail: email, backUrl: "https://x" });
    await dbs.owner.db.update(subscriptions).set({ status: "comped" }).where(eq(subscriptions.tenantId, ctx.tenantId));
    await handleMercadoPagoEvent(dbs.app.db, client, { type: "subscription_preapproval", dataId: (await subOf(ctx.tenantId)).mpPreapprovalId! });
    expect((await subOf(ctx.tenantId)).status).toBe("comped");
  });
});

describe("firma de los avisos de Mercado Pago", () => {
  const secret = "secreto-de-prueba-del-webhook";
  const now = 1_800_000_000_000;
  const sign = (dataId: string, requestId: string, ts: string) =>
    `ts=${ts},v1=${createHmac("sha256", secret).update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest("hex")}`;
  const ts = String(now);

  it("acepta una firma correcta (el id se normaliza a minusculas)", () => {
    expect(verifyMercadoPagoSignature({ secret, signatureHeader: sign("ABC123", "req-1", ts), requestId: "req-1", dataId: "ABC123", now })).toBe(true);
  });

  it("rechaza firma alterada, otro id, otro secreto, sin cabeceras o con basura", () => {
    const good = sign("abc", "req-1", ts);
    const base = { secret, signatureHeader: good, requestId: "req-1", dataId: "abc", now };
    expect(verifyMercadoPagoSignature(base)).toBe(true);
    expect(verifyMercadoPagoSignature({ ...base, dataId: "otro" })).toBe(false);
    expect(verifyMercadoPagoSignature({ ...base, requestId: "req-2" })).toBe(false);
    expect(verifyMercadoPagoSignature({ ...base, secret: "otro-secreto" })).toBe(false);
    expect(verifyMercadoPagoSignature({ ...base, signatureHeader: good.replace(/.$/, "0") })).toBe(false);
    expect(verifyMercadoPagoSignature({ ...base, signatureHeader: null })).toBe(false);
    expect(verifyMercadoPagoSignature({ ...base, signatureHeader: "basura" })).toBe(false);
    expect(verifyMercadoPagoSignature({ ...base, secret: "" })).toBe(false);
  });

  it("rechaza un aviso viejo (repeticion de una captura)", () => {
    const old = String(now - 11 * 60_000);
    expect(verifyMercadoPagoSignature({ secret, signatureHeader: sign("abc", "r", old), requestId: "r", dataId: "abc", now })).toBe(false);
  });
});

describe("conciliacion periodica con Mercado Pago (red de seguridad si se pierde un aviso)", () => {
  /** Mercado Pago controlado por id: estado, o un codigo de falla. Lo que no esta en el mapa "no existe" (404). */
  function mpByIds(map: Record<string, { status?: string; next?: string; fail?: number }>) {
    const asked: string[] = [];
    const fetchFake = (async (url: string | URL | Request) => {
      const id = new URL(String(url)).pathname.split("/").pop()!;
      asked.push(id);
      const r = map[id];
      const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
      if (!r) return json({ message: "not found" }, 404);
      if (r.fail) return json({ message: "caido" }, r.fail);
      return json({ id, status: r.status, next_payment_date: r.next ?? "2027-04-10T00:00:00.000Z" });
    }) as typeof fetch;
    return { client: new MercadoPagoClient({ accessToken: "T", baseUrl: "https://mp.test", fetch: fetchFake }), asked };
  }
  const reconcile = (client: MercadoPagoClient) => reconcileSubscriptions(dbs.app.db, client, { limit: 1000, everyMinutes: 60 });

  /** Una clinica con checkout iniciado y la prueba ya terminada (el cobro seria inmediato). */
  async function withCheckout(plan: "esencial" | "profesional" = "profesional") {
    const { ctx, email } = await newBusiness();
    const { client } = fakeMp();
    await startCheckout(dbs.app.db, ctx, client, { plan, payerEmail: email, backUrl: "https://x" });
    await dbs.owner.db.update(subscriptions).set({ trialEndsAt: new Date(Date.now() - 86_400_000) }).where(eq(subscriptions.tenantId, ctx.tenantId));
    return { ctx, id: (await subOf(ctx.tenantId)).mpPreapprovalId! };
  }

  it("un pago que NUNCA avisó queda aplicado: tarjeta, plan elegido, activa y proximo cobro", async () => {
    const { ctx, id } = await withCheckout("profesional");
    expect((await subOf(ctx.tenantId)).cardAuthorized).toBe(false);

    const { client } = mpByIds({ [id]: { status: "authorized", next: "2027-05-01T00:00:00.000Z" } });
    const r = await reconcile(client);
    expect(r.errors).toBe(0);
    expect(r.changed).toBeGreaterThanOrEqual(1);

    const sub = await subOf(ctx.tenantId);
    expect(sub).toMatchObject({ status: "active", cardAuthorized: true, pendingPlan: null });
    expect(sub.currentPeriodEnd!.toISOString()).toBe("2027-05-01T00:00:00.000Z");
    expect(sub.reconciledAt).toBeTruthy();
    const [t] = await dbs.owner.db.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
    expect(t!.plan).toBe("profesional");
  });

  it("si en Mercado Pago se cancela o se pausa por fuera, el estado se pone al dia (y se corta el acceso al vencer)", async () => {
    const a = await withCheckout();
    const b = await withCheckout();
    // ambas autorizadas primero
    await reconcile(mpByIds({ [a.id]: { status: "authorized" }, [b.id]: { status: "authorized" } }).client);
    await dbs.owner.db.update(subscriptions).set({ reconciledAt: null }).where(eq(subscriptions.tenantId, a.ctx.tenantId));
    await dbs.owner.db.update(subscriptions).set({ reconciledAt: null }).where(eq(subscriptions.tenantId, b.ctx.tenantId));

    await reconcile(mpByIds({ [a.id]: { status: "cancelled" }, [b.id]: { status: "paused" } }).client);
    expect((await subOf(a.ctx.tenantId)).status).toBe("canceled");
    expect((await subOf(b.ctx.tenantId)).status).toBe("past_due");
  });

  it("rota: una suscripcion ya revisada no se vuelve a consultar dentro de la hora", async () => {
    const { id } = await withCheckout();
    const first = mpByIds({ [id]: { status: "authorized" } });
    await reconcile(first.client);
    expect(first.asked).toContain(id);
    const second = mpByIds({ [id]: { status: "authorized" } });
    await reconcile(second.client);
    expect(second.asked).not.toContain(id);
  });

  it("si Mercado Pago falla (5xx) NO se marca como revisada: se reintenta en la siguiente vuelta; las demas siguen", async () => {
    const bad = await withCheckout();
    const good = await withCheckout();
    const r = await reconcile(mpByIds({ [bad.id]: { fail: 503 }, [good.id]: { status: "authorized" } }).client);
    expect(r.errors).toBeGreaterThanOrEqual(1);
    expect((await subOf(bad.ctx.tenantId)).reconciledAt).toBeNull();
    expect((await subOf(good.ctx.tenantId)).status).toBe("active");

    const retry = mpByIds({ [bad.id]: { status: "authorized" } });
    await reconcile(retry.client);
    expect(retry.asked).toContain(bad.id);
    expect((await subOf(bad.ctx.tenantId)).status).toBe("active");
  });

  it("un id que Mercado Pago no conoce no es error: se marca revisada y no se insiste", async () => {
    const { ctx, id } = await withCheckout();
    const r = await reconcile(mpByIds({}).client);
    expect(r.errors).toBe(0);
    expect((await subOf(ctx.tenantId)).reconciledAt).toBeTruthy();
    const again = mpByIds({});
    await reconcile(again.client);
    expect(again.asked).not.toContain(id);
  });

  it("no consulta cortesias, canceladas ni checkouts viejos sin confirmar", async () => {
    const comped = await withCheckout();
    await dbs.owner.db.update(subscriptions).set({ status: "comped" }).where(eq(subscriptions.tenantId, comped.ctx.tenantId));
    const canceled = await withCheckout();
    await dbs.owner.db.update(subscriptions).set({ status: "canceled" }).where(eq(subscriptions.tenantId, canceled.ctx.tenantId));
    const stale = await withCheckout();
    await dbs.owner.db.update(subscriptions).set({ updatedAt: new Date(Date.now() - 10 * 86_400_000) }).where(eq(subscriptions.tenantId, stale.ctx.tenantId));

    const { client, asked } = mpByIds({});
    await reconcile(client);
    expect(asked).not.toContain(comped.id);
    expect(asked).not.toContain(canceled.id);
    expect(asked).not.toContain(stale.id);
  });
});

describe("giros del registro", () => {
  it("cada giro tiene su pack de reglas (y el pack se llama igual)", () => {
    expect(VERTICALS.map((v) => v.id)).toEqual(expect.arrayContaining(["dental", "salud", "belleza", "mascotas", "bienestar", "automotriz", "profesional", "generico"]));
    for (const v of VERTICALS) {
      const pack = loadPack(v.id);
      expect(pack.slug).toBe(v.id);
      expect(pack.vertical).toBe(v.id);
      expect(pack.urgency.instruction.length).toBeGreaterThan(10);
      expect(pack.requiredAppointmentData).toMatch(/nombre/i);
    }
  });

  it("al registrarse con un giro, el negocio y el asistente quedan con ese giro y su pack", async () => {
    for (const vertical of ["belleza", "generico"] as const) {
      const email = `g-${unique()}@test.local`;
      const res = await signup(dbs.app.db, { businessName: `Negocio ${vertical}`, vertical, ownerName: "Ana", email, password: PASS });
      if (!res.ok) throw new Error(`signup fallo: ${res.error}`);
      tenantIds.push(res.tenantId);
      userIds.push(res.userId);
      const [tenant] = await dbs.owner.db.select().from(tenants).where(eq(tenants.id, res.tenantId));
      const [config] = await dbs.owner.db.select().from(agentConfigs).where(eq(agentConfigs.tenantId, res.tenantId));
      expect(tenant).toMatchObject({ vertical, status: "pending" });
      expect(config).toMatchObject({ packSlug: vertical });
    }
  });
});
