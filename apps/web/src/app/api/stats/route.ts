import { getStats, operatorSupportContext } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed, failure } from "@/lib/api";
import { UUID } from "@/lib/operator";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * Estadisticas del negocio de la sesion. ?days=7|30|90 (otro valor = 30). El costo de IA solo lo recibe el dueño.
 * Con ?tenant=<id> las ve un OPERADOR de la plataforma para ese cliente (la base confirma que lo es).
 */
export const GET = authed(async (req, ctx) => {
  const days = Number(req.nextUrl.searchParams.get("days") ?? 30);
  const tenant = req.nextUrl.searchParams.get("tenant");
  let target = ctx;
  if (tenant) {
    if (!UUID.test(tenant)) return failure("bad_request");
    const support = await operatorSupportContext(getDb(), ctx.userId, tenant);
    if (!support) return failure("forbidden");
    target = support;
  }
  return NextResponse.json({ ok: true, stats: await getStats(getDb(), target, { days }) });
});
