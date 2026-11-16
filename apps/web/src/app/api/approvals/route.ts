import { listApprovals } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = authed(async (req, ctx) => {
  const status = req.nextUrl.searchParams.get("status") === "reviewed" ? "reviewed" : "pending";
  return NextResponse.json({ ok: true, items: await listApprovals(getDb(), ctx, { status }) });
});
