import { listOrders } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed, failure, respond } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** GET /api/orders?scope=active|history → los pedidos del tablero (en curso, o entregados y cancelados de la ultima semana). */
export const GET = authed(async (req, ctx) => {
  const scope = new URL(req.url).searchParams.get("scope") ?? "active";
  if (scope !== "active" && scope !== "history") return failure("bad_request");
  const r = await listOrders(getDb(), ctx, scope);
  return r.ok ? NextResponse.json(r) : respond(r);
});
