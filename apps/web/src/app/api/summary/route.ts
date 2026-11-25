import { countNewOrders, getBilling, listApprovals, listConversations } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { getDb, getMercadoPago, workerAlive } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Numeros para las insignias del menu y el estado del servicio de envio. */
export const GET = authed(async (_req, ctx) => {
  const db = getDb();
  const [attention, approvals, worker, billing, orders] = await Promise.all([
    listConversations(db, ctx, { filter: "attention", limit: 100 }),
    listApprovals(db, ctx, { status: "pending", limit: 100 }),
    workerAlive(),
    getBilling(db, ctx, getMercadoPago() !== null),
    countNewOrders(db, ctx),
  ]);
  // El acceso (aprobacion + suscripcion) tambien viaja aqui para que la franja de aviso se actualice sola.
  const access = {
    allowed: billing.access.allowed,
    reason: billing.access.reason,
    trialEndsAt: billing.subscription?.trialEndsAt?.toISOString() ?? null,
  };
  return NextResponse.json({ ok: true, attention: attention.length, approvals: approvals.length, orders, worker, access });
});
