import { getOnboarding } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** GET /api/onboarding → «Primeros pasos»: los pasos para dejar listo el negocio y el porcentaje de avance. */
export const GET = authed(async (_req, ctx) => NextResponse.json({ ok: true, ...(await getOnboarding(getDb(), ctx)) }));
