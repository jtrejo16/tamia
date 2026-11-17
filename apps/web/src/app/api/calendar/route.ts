import { getCalendarConnection } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { googleDeps } from "@/lib/google";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Estado de la conexion con Google Calendar y si el servidor la ofrece. */
export const GET = authed(async (_req, ctx) =>
  NextResponse.json({ ok: true, calendar: await getCalendarConnection(getDb(), ctx), available: googleDeps() !== null }),
);
