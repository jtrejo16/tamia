import { isOperator, operatorCostRows, operatorOverviewRows, type OperatorCostRow } from "@empleado/db";
import { priceTenant, type CostConfig, type TenantCost, type TenantUsage } from "@empleado/shared";
import { billingState, type BillingBucket } from "./operator-console";
import { fail, type Failure, type Success } from "./types";

/**
 * Costos de la plataforma para el operador: IA (real), llamadas de Retell (real, o estimado si Retell no lo reporto),
 * telefonia y cargos de Meta por plantillas (estimados con tarifas editables) y costos fijos mensuales.
 * El permiso lo decide la base de datos (operator_costs solo responde al operador).
 */

export type CostPeriod = "month" | "last_month" | "30d" | "7d";

export function periodRange(period: CostPeriod, now = new Date()): { from: Date; to: Date; days: number; label: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  let from: Date;
  let to: Date;
  let label: string;
  switch (period) {
    case "last_month":
      from = new Date(Date.UTC(y, m - 1, 1));
      to = new Date(Date.UTC(y, m, 1));
      label = "Mes pasado";
      break;
    case "30d":
      to = now;
      from = new Date(now.getTime() - 30 * 86_400_000);
      label = "Últimos 30 días";
      break;
    case "7d":
      to = now;
      from = new Date(now.getTime() - 7 * 86_400_000);
      label = "Últimos 7 días";
      break;
    default:
      from = new Date(Date.UTC(y, m, 1));
      to = now;
      label = "Este mes";
  }
  const days = Math.max(1 / 24, (to.getTime() - from.getTime()) / 86_400_000);
  return { from, to, days, label };
}

export interface ClientCost {
  tenantId: string;
  name: string;
  plan: string;
  status: string;
  bucket: BillingBucket;
  usage: TenantUsage & { aiTokensIn: number; aiTokensOut: number; callCount: number; waIn: number; waOut: number };
  cost: TenantCost;
  /** Lo que aporta en el periodo (USD), proporcional a los dias: solo suscripciones que pagan. */
  revenueUsd: number;
  /** Ingreso - costo variable (USD). Un cliente en prueba/cortesia sale negativo: es lo que cuesta atenderlo. */
  marginUsd: number;
}

export interface CostTotals {
  aiUsd: number;
  voiceUsd: number;
  phoneUsd: number;
  whatsappUsd: number;
  variableUsd: number;
  fixedUsd: number;
  totalUsd: number;
  estimatedUsd: number;
  revenueUsd: number;
  /** Ingreso - costo variable - costos fijos. */
  profitUsd: number;
  callMinutes: number;
  tplSent: number;
}

export interface CostReport {
  period: { id: CostPeriod; label: string; from: Date; to: Date; days: number };
  config: CostConfig;
  clients: ClientCost[];
  totals: CostTotals;
  fixed: Array<{ name: string; usd: number }>;
}

const toUsage = (r: OperatorCostRow): ClientCost["usage"] => ({
  aiMicros: r.aiMicros,
  callSeconds: r.callSeconds,
  callRecordedMicros: r.callRecordedMicros,
  callUnpricedSeconds: r.callUnpricedSeconds,
  tplMarketing: r.tplMarketing,
  tplUtility: r.tplUtility,
  tplAuthentication: r.tplAuthentication,
  tplUnknown: r.tplUnknown,
  aiTokensIn: r.aiTokensIn,
  aiTokensOut: r.aiTokensOut,
  callCount: r.callCount,
  waIn: r.waIn,
  waOut: r.waOut,
});

/** Calcula el reporte (puro): util para pruebas sin base de datos. */
export function buildCostReport(
  period: CostPeriod,
  config: CostConfig,
  usage: OperatorCostRow[],
  clients: Array<{ id: string; name: string; plan: string; status: string; bucket: BillingBucket; mrrMxn: number }>,
  now = new Date(),
): CostReport {
  const range = periodRange(period, now);
  const byTenant = new Map(usage.map((u) => [u.tenantId, u]));
  const rows: ClientCost[] = clients.map((c) => {
    const u = byTenant.get(c.id);
    const use = u ? toUsage(u) : toUsage({ tenantId: c.id, aiMicros: 0, aiTokensIn: 0, aiTokensOut: 0, callCount: 0, callSeconds: 0, callRecordedMicros: 0, callUnpricedSeconds: 0, tplMarketing: 0, tplUtility: 0, tplAuthentication: 0, tplUnknown: 0, waIn: 0, waOut: 0 });
    const cost = priceTenant(use, config.rates);
    const revenueUsd = (c.mrrMxn / config.usdMxn) * (range.days / 30);
    return { tenantId: c.id, name: c.name, plan: c.plan, status: c.status, bucket: c.bucket, usage: use, cost, revenueUsd, marginUsd: revenueUsd - cost.totalUsd };
  });
  rows.sort((a, b) => b.cost.totalUsd - a.cost.totalUsd);

  const sum = (f: (r: ClientCost) => number) => rows.reduce((s, r) => s + f(r), 0);
  const fixed = config.fixed.map((f) => ({ name: f.name, usd: (f.usdMonthly * range.days) / 30 }));
  const fixedUsd = fixed.reduce((s, f) => s + f.usd, 0);
  const variableUsd = sum((r) => r.cost.totalUsd);
  const revenueUsd = sum((r) => r.revenueUsd);
  return {
    period: { id: period, label: range.label, from: range.from, to: range.to, days: range.days },
    config,
    clients: rows,
    fixed,
    totals: {
      aiUsd: sum((r) => r.cost.aiUsd),
      voiceUsd: sum((r) => r.cost.voiceUsd),
      phoneUsd: sum((r) => r.cost.phoneUsd),
      whatsappUsd: sum((r) => r.cost.whatsappUsd),
      variableUsd,
      fixedUsd,
      totalUsd: variableUsd + fixedUsd,
      estimatedUsd: sum((r) => r.cost.estimatedUsd),
      revenueUsd,
      profitUsd: revenueUsd - variableUsd - fixedUsd,
      callMinutes: sum((r) => r.usage.callSeconds) / 60,
      tplSent: sum((r) => r.usage.tplMarketing + r.usage.tplUtility + r.usage.tplAuthentication + r.usage.tplUnknown),
    },
  };
}

export async function operatorCosts(
  db: Parameters<typeof operatorCostRows>[0],
  userId: string,
  config: CostConfig,
  period: CostPeriod = "month",
  now = new Date(),
): Promise<Success<{ report: CostReport }> | Failure<"forbidden">> {
  if (!(await isOperator(db, userId))) return fail("forbidden");
  const range = periodRange(period, now);
  const [usage, overview] = await Promise.all([operatorCostRows(db, userId, range.from, range.to), operatorOverviewRows(db, userId)]);
  const clients = overview.map((r) => {
    const b = billingState(r, now);
    return { id: r.id, name: r.name, plan: r.plan, status: r.status, bucket: b.bucket, mrrMxn: b.mrrMxn };
  });
  return { ok: true, report: buildCostReport(period, config, usage, clients, now) };
}
