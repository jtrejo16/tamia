import { NextResponse, type NextRequest } from "next/server";
import { failure, sameOrigin } from "@/lib/api";
import { endSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return failure("bad_origin");
  await endSession();
  return NextResponse.json({ ok: true });
}
