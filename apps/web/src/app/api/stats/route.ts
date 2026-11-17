import { getStats } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Estadisticas del negocio de la sesion. ?days=7|30|90 (otro valor = 30). El costo de IA solo lo recibe el dueño. */
export const GET = authed(async (req, ctx) => {
  const days = Number(req.nextUrl.searchParams.get("days") ?? 30);
  return NextResponse.json({ ok: true, stats: await getStats(getDb(), ctx, { days }) });
});
