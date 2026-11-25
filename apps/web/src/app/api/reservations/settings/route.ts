import { getReservationSettings, saveReservationSettings } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed, readJson, respond } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** GET /api/reservations/settings → aforo y reglas de reservacion. */
export const GET = authed(async (_req, ctx) => {
  const r = await getReservationSettings(getDb(), ctx);
  return r.ok ? NextResponse.json(r) : respond(r);
});

/** POST /api/reservations/settings  { enabled, capacity, stayMinutes, slotMinutes, maxParty, minNoticeMinutes, maxDaysAhead, lastSeatingMinutes } */
export const POST = authed(async (req, ctx) => respond(await saveReservationSettings(getDb(), ctx, await readJson(req))));
