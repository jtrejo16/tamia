import { can, listMembers } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed, failure } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = authed(async (_req, ctx) => {
  if (!can(ctx.role, "manage_users")) return failure("forbidden");
  return NextResponse.json({ ok: true, items: await listMembers(getDb(), ctx) });
});
