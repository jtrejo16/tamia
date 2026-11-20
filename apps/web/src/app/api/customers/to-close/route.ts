import { listAppointmentsToClose } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Citas que ya terminaron y siguen pendientes o confirmadas: falta marcar si vino o no. */
export const GET = authed(async (_req, ctx) => NextResponse.json({ ok: true, items: await listAppointmentsToClose(getDb(), ctx) }));
