import { calls, messages, templates, usageEvents, users } from "@empleado/db";
import { DEFAULT_RATES, costConfigFromEnv, priceTenant } from "@empleado/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCostReport, handleCallEvent, operatorCosts, periodRange, retellCostMicros } from "../src";
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

const RATES = { whatsapp: { marketing: 0.04, utility: 0.01, authentication: 0.01, service: 0.01 }, serviceFreePerMonth: 1000, phonePerMinute: 0.02, retellFallbackPerMinute: 0.1 };
const NO_WA = { aiMicros: 0, callSeconds: 0, callRecordedMicros: 0, callUnpricedSeconds: 0, tplMarketing: 0, tplUtility: 0, tplAuthentication: 0, tplUnknown: 0, svcLegacy: 0, billedMarketing: 0, billedUtility: 0, billedAuthentication: 0, billedService: 0, billedOther: 0, svcFreeTier: 1000 };

describe("configuracion y precios", () => {
  it("las respuestas de servicio son gratis hasta 1,000 al mes por numero y despues se cobran (politica de Meta desde oct-2026)", () => {
    const at = (svcLegacy: number) => priceTenant({ ...NO_WA, svcLegacy }, RATES).whatsappUsd;
    expect(at(800)).toBe(0);
    expect(at(1000)).toBe(0);
    expect(at(1500)).toBeCloseTo(500 * 0.01);
    // Con dato de Meta se cuentan exactamente los que SI cobra, sin aplicar la regla de los gratis (Meta ya la aplico).
    expect(priceTenant({ ...NO_WA, billedService: 300, billedUtility: 10, billedMarketing: 2, billedOther: 5 }, RATES).whatsappUsd).toBeCloseTo((300 + 5) * 0.01 + 10 * 0.01 + 2 * 0.04);
    // Mezcla: lo que ya se facturo cuenta contra los gratis.
    expect(priceTenant({ ...NO_WA, billedService: 1000, svcLegacy: 10 }, RATES).whatsappUsd).toBeCloseTo(1000 * 0.01 + 10 * 0.01);
  });

  it("el cobro de servicio usa por defecto la tarifa de utilidad, y se puede fijar aparte", () => {
    expect(costConfigFromEnv({ COST_RATES: JSON.stringify({ whatsapp: { utility: 0.02 } }) }).rates.whatsapp.service).toBe(0.02);
    expect(costConfigFromEnv({ COST_RATES: JSON.stringify({ whatsapp: { utility: 0.02, service: 0.03 }, serviceFreePerMonth: 500 }) }).rates).toMatchObject({ whatsapp: { service: 0.03 }, serviceFreePerMonth: 500 });
  });

  it("usa tarifas por defecto y tolera valores mal escritos", () => {
    const c = costConfigFromEnv({});
    expect(c.rates).toEqual(DEFAULT_RATES);
    expect(c.fixed).toEqual([]);
    expect(c.usdMxn).toBe(18);
    const bad = costConfigFromEnv({ COST_RATES: "{no es json", COST_FIXED_MONTHLY_USD: "xx", USD_MXN: "abc" });
    expect(bad.rates).toEqual(DEFAULT_RATES);
    expect(bad.usdMxn).toBe(18);
  });

  it("permite ajustar tarifas, costos fijos y tipo de cambio", () => {
    const c = costConfigFromEnv({
      COST_RATES: JSON.stringify({ whatsapp: { marketing: 0.05 }, phonePerMinute: 0.02, retellFallbackPerMinute: -1 }),
      COST_FIXED_MONTHLY_USD: JSON.stringify({ Railway: 20, Dominio: 1.5, malo: -3 }),
      USD_MXN: "17.2",
    });
    expect(c.rates.whatsapp.marketing).toBe(0.05);
    expect(c.rates.whatsapp.utility).toBe(DEFAULT_RATES.whatsapp.utility);
    expect(c.rates.phonePerMinute).toBe(0.02);
    expect(c.rates.retellFallbackPerMinute).toBe(DEFAULT_RATES.retellFallbackPerMinute); // negativo: se ignora
    expect(c.fixed).toEqual([{ name: "Railway", usdMonthly: 20 }, { name: "Dominio", usdMonthly: 1.5 }]);
    expect(c.usdMxn).toBe(17.2);
  });

  it("suma IA real, voz real + estimada, telefonia y plantillas de Meta", () => {
    const cost = priceTenant(
      { ...NO_WA, aiMicros: 2_500_000, callSeconds: 600, callRecordedMicros: 400_000, callUnpricedSeconds: 120, tplMarketing: 10, tplUtility: 4, tplAuthentication: 0, tplUnknown: 1 },
      RATES,
    );
    expect(cost.aiUsd).toBeCloseTo(2.5);
    expect(cost.voiceUsd).toBeCloseTo(0.4 + 0.2); // real + 2 min estimados
    expect(cost.phoneUsd).toBeCloseTo(0.2); // 10 min
    expect(cost.whatsappUsd).toBeCloseTo(10 * 0.04 + 5 * 0.01);
    expect(cost.totalUsd).toBeCloseTo(2.5 + 0.6 + 0.2 + 0.45);
    expect(cost.estimatedUsd).toBeCloseTo(0.2 + 0.2 + 0.45); // lo medido (IA y voz real) no cuenta como estimado
  });

  it("convierte centavos de Retell a millonesimas de dolar", () => {
    expect(retellCostMicros({ call_cost: { combined_cost: 12.5 } })).toBe(125_000); // 12.5 centavos = $0.125
    expect(retellCostMicros({})).toBeNull();
    expect(retellCostMicros({ call_cost: { combined_cost: -1 } })).toBeNull();
  });

  it("reparte el costo fijo y el ingreso segun los dias del periodo", () => {
    const now = new Date("2027-03-16T12:00:00Z");
    expect(periodRange("last_month", now).days).toBe(28);
    const cfg = costConfigFromEnv({ COST_FIXED_MONTHLY_USD: JSON.stringify({ Railway: 30 }), USD_MXN: "20" });
    const usage = { tenantId: "a", aiMicros: 1_000_000, aiTokensIn: 0, aiTokensOut: 0, callCount: 0, callSeconds: 0, callRecordedMicros: 0, callUnpricedSeconds: 0, tplMarketing: 0, tplUtility: 0, tplAuthentication: 0, tplUnknown: 0, svcLegacy: 0, billedMarketing: 0, billedUtility: 0, billedAuthentication: 0, billedService: 0, billedOther: 0, waIn: 0, waOut: 0 };
    const rep = buildCostReport("7d", cfg, [usage], [{ id: "a", name: "A", plan: "profesional", status: "active", bucket: "paid", mrrMxn: 3000 }, { id: "b", name: "B", plan: "esencial", status: "active", bucket: "trial", mrrMxn: 0 }], now);
    expect(rep.fixed[0]!.usd).toBeCloseTo((30 * 7) / 30);
    expect(rep.clients[0]!.tenantId).toBe("a"); // el mas caro primero
    expect(rep.clients[0]!.revenueUsd).toBeCloseTo((3000 / 20) * (7 / 30));
    expect(rep.clients[1]!.marginUsd).toBe(0); // en prueba y sin consumo
    expect(rep.totals.profitUsd).toBeCloseTo(rep.totals.revenueUsd - 1 - 7);
  });
});

describe("costos (base de datos)", () => {
  it("guarda el costo real de la llamada que reporta Retell, y solo el operador ve los costos", async () => {
    const op = await makeWorld(dbs.owner);
    const client = await makeWorld(dbs.owner);
    worlds.push(op, client);
    await dbs.owner.db.update(users).set({ isOperator: true }).where(eq(users.id, op.ownerId));

    // Llamada que Retell reporta con costo, y otra sin costo.
    await dbs.owner.db.insert(calls).values([
      { tenantId: client.tenantId, retellCallId: `c-${client.tenantId}-1`, status: "ended", startedAt: new Date(), durationSeconds: 120, costUsdMicros: 300_000 },
      { tenantId: client.tenantId, retellCallId: `c-${client.tenantId}-2`, status: "ended", startedAt: new Date(), durationSeconds: 60 },
    ]);
    await dbs.owner.db.insert(usageEvents).values({ tenantId: client.tenantId, kind: "llm", model: "m", tokensIn: 100, tokensOut: 50, costUsdMicros: 1_500_000 });

    // Plantillas: una de marketing y una de utilidad enviadas; una fallida no se cobra.
    await dbs.owner.db.insert(templates).values([
      { tenantId: client.tenantId, channelId: client.channelId, name: "promo_mes", category: "marketing", components: [], status: "approved" },
      { tenantId: client.tenantId, channelId: client.channelId, name: "recordatorio_24h", category: "utility", components: [], status: "approved" },
    ]);
    const tpl = (name: string, status: "sent" | "failed") => ({
      tenantId: client.tenantId,
      conversationId: client.conversationId,
      channelId: client.channelId,
      direction: "out" as const,
      sender: "bot" as const,
      type: "template" as const,
      body: JSON.stringify({ kind: "template", name, language: "es_MX", params: [], buttons: [], text: "x" }),
      status,
    });
    await dbs.owner.db.insert(messages).values([tpl("promo_mes", "sent"), tpl("promo_mes", "sent"), tpl("recordatorio_24h", "sent"), tpl("promo_mes", "failed"), tpl("borrada", "sent")]);

    expect(await operatorCosts(dbs.app.db, client.ownerId, costConfigFromEnv({}))).toMatchObject({ ok: false, error: "forbidden" });

    const r = await operatorCosts(dbs.app.db, op.ownerId, costConfigFromEnv({}), "7d");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.report.clients.find((x) => x.tenantId === client.tenantId)!;
    expect(c.usage).toMatchObject({ aiMicros: 1_500_000, callCount: 2, callSeconds: 180, callRecordedMicros: 300_000, callUnpricedSeconds: 60, tplMarketing: 2, tplUtility: 1, tplUnknown: 1 });
    expect(c.cost.aiUsd).toBeCloseTo(1.5);
    expect(c.cost.voiceUsd).toBeCloseTo(0.3 + (60 / 60) * DEFAULT_RATES.retellFallbackPerMinute);
    expect(c.cost.whatsappUsd).toBeCloseTo(2 * DEFAULT_RATES.whatsapp.marketing + 2 * DEFAULT_RATES.whatsapp.utility);
    expect(JSON.stringify(r.report)).not.toMatch(/credentials|accessToken|body/i);
  });

  it("cuenta las respuestas del asistente (servicio) y usa el dato real de Meta cuando lo hay", async () => {
    const op = await makeWorld(dbs.owner);
    const client = await makeWorld(dbs.owner);
    worlds.push(op, client);
    await dbs.owner.db.update(users).set({ isOperator: true }).where(eq(users.id, op.ownerId));
    const out = (over: Partial<typeof messages.$inferInsert>) => ({
      tenantId: client.tenantId, conversationId: client.conversationId, channelId: client.channelId,
      direction: "out" as const, sender: "bot" as const, type: "text" as const, body: "respuesta", status: "delivered" as const, ...over,
    });
    await dbs.owner.db.insert(messages).values([
      out({}), out({}), out({}), // respuestas sin dato de Meta aun: se estiman como servicio
      out({ pricingCategory: "service", billable: false }), // dentro de los gratis: Meta no cobra
      out({ pricingCategory: "service", billable: true }), out({ pricingCategory: "service", billable: true }), // pasados los gratis
      out({ pricingCategory: "utility", billable: true }),
      out({ pricingCategory: "marketing", billable: true }),
      { ...out({ body: "hola" }), direction: "in" as const, sender: "contact" as const, status: "received" as const }, // del cliente: no se cobra
    ]);

    const r = await operatorCosts(dbs.app.db, op.ownerId, costConfigFromEnv({}), "7d");
    if (!r.ok) throw new Error("sin reporte");
    const c = r.report.clients.find((x) => x.tenantId === client.tenantId)!;
    expect(c.usage).toMatchObject({ svcLegacy: 3, billedService: 2, billedUtility: 1, billedMarketing: 1, waIn: 1 });
    expect(c.usage.svcFreeTier).toBeGreaterThan(0);
    // 3 respuestas sin dato caben en los gratis; los 4 cobrados por Meta se cuentan tal cual.
    expect(c.cost.whatsappUsd).toBeCloseTo(2 * DEFAULT_RATES.whatsapp.service + DEFAULT_RATES.whatsapp.utility + DEFAULT_RATES.whatsapp.marketing);
    expect(r.report.totals.serviceMsgs).toBeGreaterThanOrEqual(5);
  });

  it("al terminar la llamada Retell, el costo queda en la llamada", async () => {
    const w = await makeWorld(dbs.owner);
    worlds.push(w);
    const { voiceSettings } = await import("@empleado/db");
    await dbs.owner.db.insert(voiceSettings).values({ tenantId: w.tenantId, enabled: true, retellAgentId: `agent-${w.tenantId}` });
    const base = { call_id: `call-${w.tenantId}`, agent_id: `agent-${w.tenantId}`, direction: "inbound", start_timestamp: Date.now() - 90_000, end_timestamp: Date.now() };
    await handleCallEvent(dbs.app.db, { event: "call_ended", call: base });
    let [row] = await dbs.owner.db.select().from(calls).where(eq(calls.retellCallId, base.call_id));
    expect(row!.costUsdMicros).toBeNull(); // aun no lo reporta
    await handleCallEvent(dbs.app.db, { event: "call_analyzed", call: { ...base, call_cost: { combined_cost: 21 } } });
    [row] = await dbs.owner.db.select().from(calls).where(eq(calls.retellCallId, base.call_id));
    expect(row!.costUsdMicros).toBe(210_000);
    // Un aviso posterior sin costo no lo borra.
    await handleCallEvent(dbs.app.db, { event: "call_analyzed", call: base });
    [row] = await dbs.owner.db.select().from(calls).where(eq(calls.retellCallId, base.call_id));
    expect(row!.costUsdMicros).toBe(210_000);
  });
});
