import { listApprovals, listConversations } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { getDb, workerAlive } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Numeros para las insignias del menu y el estado del servicio de envio. */
export const GET = authed(async (_req, ctx) => {
  const db = getDb();
  const [attention, approvals, worker] = await Promise.all([
    listConversations(db, ctx, { filter: "attention", limit: 100 }),
    listApprovals(db, ctx, { status: "pending", limit: 100 }),
    workerAlive(),
  ]);
  return NextResponse.json({ ok: true, attention: attention.length, approvals: approvals.length, worker });
});
