import { operatorTenantDetail } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed, failure, respond } from "@/lib/api";
import { UUID } from "@/lib/operator";
import { getDb, getMercadoPago, getRetell } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Detalle de un cliente: cobro, conexiones, equipo, bitacora y mensajes fallidos. Solo operador. */
export const GET = authed(async (req, ctx) => {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!UUID.test(id)) return failure("bad_request");
  const r = await operatorTenantDetail(getDb(), ctx.userId, id, { paymentsEnabled: getMercadoPago() !== null, retellConfigured: getRetell() !== null });
  return r.ok ? NextResponse.json(r) : respond(r);
});
