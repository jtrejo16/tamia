import { getChannel } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Estado del WhatsApp del negocio. Nunca incluye la clave de acceso. */
export const GET = authed(async (_req, ctx) => NextResponse.json({ ok: true, channel: await getChannel(getDb(), ctx) }));
