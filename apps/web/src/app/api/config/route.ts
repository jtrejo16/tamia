import { getConfig } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed, failure } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = authed(async (_req, ctx) => {
  const config = await getConfig(getDb(), ctx);
  return config ? NextResponse.json({ ok: true, config }) : failure("not_found");
});
