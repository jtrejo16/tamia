import { describe, expect, it } from "vitest";
import { GRACE_DAYS, accessEndsAt, accessFor, type SubscriptionFacts } from "../src/plans";

const NOW = new Date("2027-03-10T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const sub = (over: Partial<SubscriptionFacts>): SubscriptionFacts => ({
  status: "trialing",
  trialEndsAt: days(5),
  currentPeriodEnd: null,
  cardAuthorized: false,
  ...over,
});

describe("accessFor: cuando responde el asistente", () => {
  it("un negocio pendiente de aprobar NO tiene acceso aunque su prueba este vigente", () => {
    expect(accessFor("pending", sub({}), NOW)).toEqual({ allowed: false, reason: "tenant_pending" });
  });

  it("pausado o cancelado por el operador: sin acceso", () => {
    expect(accessFor("paused", sub({}), NOW).reason).toBe("tenant_inactive");
    expect(accessFor("cancelled", sub({}), NOW).reason).toBe("tenant_inactive");
  });

  it("sin suscripcion registrada: sin acceso", () => {
    expect(accessFor("active", null, NOW).reason).toBe("no_subscription");
  });

  it("prueba vigente: acceso; prueba vencida sin tarjeta: sin acceso", () => {
    expect(accessFor("active", sub({}), NOW).allowed).toBe(true);
    expect(accessFor("active", sub({ trialEndsAt: days(-1) }), NOW)).toEqual({ allowed: false, reason: "trial_ended" });
  });

  it("prueba vencida CON tarjeta autorizada: da gracia a que llegue el cobro, luego corta", () => {
    const withCard = (d: number) => sub({ trialEndsAt: days(d), cardAuthorized: true });
    expect(accessFor("active", withCard(-1), NOW).allowed).toBe(true);
    expect(accessFor("active", withCard(-GRACE_DAYS - 1), NOW).allowed).toBe(false);
  });

  it("suscripcion activa: acceso; con periodo vencido mas alla de la gracia: sin acceso", () => {
    expect(accessFor("active", sub({ status: "active", currentPeriodEnd: days(10) }), NOW).allowed).toBe(true);
    expect(accessFor("active", sub({ status: "active", currentPeriodEnd: days(-1) }), NOW).allowed).toBe(true);
    expect(accessFor("active", sub({ status: "active", currentPeriodEnd: days(-GRACE_DAYS - 1) }), NOW).reason).toBe("payment_overdue");
  });

  it("pago pendiente: solo mientras dure la gracia", () => {
    expect(accessFor("active", sub({ status: "past_due", currentPeriodEnd: days(-1) }), NOW).allowed).toBe(true);
    expect(accessFor("active", sub({ status: "past_due", currentPeriodEnd: null }), NOW).allowed).toBe(false);
  });

  it("cancelar NO corta lo ya pagado: acceso hasta el fin del periodo (o de la prueba), despues no", () => {
    const paid = (end: number | null, trial: number | null) => sub({ status: "canceled", currentPeriodEnd: end === null ? null : days(end), trialEndsAt: trial === null ? null : days(trial) });
    expect(accessFor("active", paid(10, -20), NOW)).toEqual({ allowed: true, reason: "ok" }); // pago el mes: faltan 10 dias
    expect(accessFor("active", paid(null, 5), NOW).allowed).toBe(true); // cancelo en plena prueba
    expect(accessFor("active", paid(-1, -20), NOW)).toEqual({ allowed: false, reason: "canceled" }); // ya se acabo
    expect(accessFor("active", paid(null, null), NOW)).toEqual({ allowed: false, reason: "canceled" });
    expect(accessFor("pending", paid(10, null), NOW).reason).toBe("tenant_pending"); // sigue mandando la aprobacion
    expect(accessFor("paused", paid(10, null), NOW).reason).toBe("tenant_inactive");
  });

  it("accessEndsAt: el mas tardio entre lo pagado y la prueba", () => {
    expect(accessEndsAt(sub({ status: "canceled", currentPeriodEnd: days(10), trialEndsAt: days(-20) }))).toEqual(days(10));
    expect(accessEndsAt(sub({ status: "canceled", currentPeriodEnd: null, trialEndsAt: null }))).toBeNull();
  });

  it("cortesia: siempre con acceso", () => {
    expect(accessFor("active", sub({ status: "comped", trialEndsAt: null }), NOW).allowed).toBe(true);
  });
});
