import { createManualReservation, listReservations } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed, readJson, respond } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** GET /api/reservations?date=AAAA-MM-DD → la agenda del dia (por defecto hoy) con comensales y aforo. */
export const GET = authed(async (req, ctx) => {
  const date = new URL(req.url).searchParams.get("date") ?? undefined;
  const r = await listReservations(getDb(), ctx, { date });
  return r.ok ? NextResponse.json(r) : respond(r);
});

/** POST /api/reservations  { name, phone, date, time, partySize, notes?, ignoreCapacity? } → anota una reservacion a mano. */
export const POST = authed(async (req, ctx) => respond(await createManualReservation(getDb(), ctx, await readJson(req))));
