import { operatorOverview } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed, respond } from "@/lib/api";
import { platformStatus } from "@/lib/operator";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Todos los clientes con cobro y salud, el resumen de la plataforma y el estado del servicio. Solo operador (lo valida la base). */
export const GET = authed(async (_req, ctx) => {
  const overview = await operatorOverview(getDb(), ctx.userId);
  if (!overview.ok) return respond(overview);
  return NextResponse.json({ ...overview, platform: await platformStatus() });
});
