import { listSocialChannels } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { socialDeps } from "@/lib/facebook";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = authed(async (_req, ctx) =>
  NextResponse.json({ ok: true, available: socialDeps() !== null, channels: await listSocialChannels(getDb(), ctx) }),
);
