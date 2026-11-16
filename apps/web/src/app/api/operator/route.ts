import { operatorTenants } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed, respond } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = authed(async (_req, ctx) => respond(await operatorTenants(getDb(), ctx.userId)) as NextResponse);
