import { getBilling } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { getDb, getMercadoPago } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = authed(async (_req, ctx) => {
  const billing = await getBilling(getDb(), ctx, getMercadoPago() !== null);
  return NextResponse.json({ ok: true, ...billing });
});
