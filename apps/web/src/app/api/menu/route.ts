import { getMenu } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed, respond } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** GET /api/menu → el menu completo del negocio (categorias con platillos, y los grupos de modificadores). */
export const GET = authed(async (_req, ctx) => {
  const r = await getMenu(getDb(), ctx);
  return r.ok ? NextResponse.json(r) : respond(r);
});
