import { getRestaurantSettings, saveRestaurantSettings } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed, readJson, respond } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** GET /api/orders/settings → ajustes de pedidos del negocio. */
export const GET = authed(async (_req, ctx) => {
  const r = await getRestaurantSettings(getDb(), ctx);
  return r.ok ? NextResponse.json(r) : respond(r);
});

/** POST /api/orders/settings  { acceptingOrders, prepMinutes, minOrderPesos, paymentMethods, transferInfo? } */
export const POST = authed(async (req, ctx) => respond(await saveRestaurantSettings(getDb(), ctx, await readJson(req))));
