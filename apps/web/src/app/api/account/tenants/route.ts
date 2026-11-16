import { listMyTenants } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = authed(
  async (_req, ctx, _params, session) => {
    const items = await listMyTenants(getDb(), ctx.userId);
    return NextResponse.json({ ok: true, items, current: session.tid });
  },
  { allowWhileMustChange: true },
);
