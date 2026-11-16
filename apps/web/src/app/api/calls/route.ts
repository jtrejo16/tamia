import { listCalls } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = authed(async (_req, ctx) => NextResponse.json({ ok: true, items: await listCalls(getDb(), ctx) }));
