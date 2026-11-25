import { countNewOrders, countUpcomingReservationsToday, getBilling, getOnboarding, listApprovals, listConversations } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { getDb, getMercadoPago, workerAlive } from "@/lib/server";

export const dynamic = "force-dynamic";

/** El avance de «Primeros pasos» cambia poco y cuesta varias consultas: se recalcula como mucho cada 30 s por negocio. */
const setupCache = new Map<string, { at: number; percent: number }>();
async function setupPercent(db: ReturnType<typeof getDb>, ctx: Parameters<typeof getOnboarding>[1]): Promise<number> {
  const hit = setupCache.get(ctx.tenantId);
  if (hit && Date.now() - hit.at < 30_000) return hit.percent;
  const percent = (await getOnboarding(db, ctx)).percent;
  if (setupCache.size > 500) setupCache.clear();
  setupCache.set(ctx.tenantId, { at: Date.now(), percent });
  return percent;
}

/** Numeros para las insignias del menu y el estado del servicio de envio. */
export const GET = authed(async (_req, ctx) => {
  const db = getDb();
  const [attention, approvals, worker, billing, orders, reservations, setup] = await Promise.all([
    listConversations(db, ctx, { filter: "attention", limit: 100 }),
    listApprovals(db, ctx, { status: "pending", limit: 100 }),
    workerAlive(),
    getBilling(db, ctx, getMercadoPago() !== null),
    countNewOrders(db, ctx),
    countUpcomingReservationsToday(db, ctx),
    setupPercent(db, ctx),
  ]);
  // El acceso (aprobacion + suscripcion) tambien viaja aqui para que la franja de aviso se actualice sola.
  const access = {
    allowed: billing.access.allowed,
    reason: billing.access.reason,
    trialEndsAt: billing.subscription?.trialEndsAt?.toISOString() ?? null,
  };
  return NextResponse.json({ ok: true, attention: attention.length, approvals: approvals.length, orders, reservations, setup, worker, access });
});
