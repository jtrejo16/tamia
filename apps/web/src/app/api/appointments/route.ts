import { listAppointments } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = authed(async (req, ctx) => {
  const includeInactive = req.nextUrl.searchParams.get("all") === "1";
  return NextResponse.json({ ok: true, items: await listAppointments(getDb(), ctx, { includeInactive }) });
});
