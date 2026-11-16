import { getConversation } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed, failure } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = authed<{ id: string }>(async (_req, ctx, { id }) => {
  const detail = await getConversation(getDb(), ctx, id);
  return detail ? NextResponse.json({ ok: true, conversation: detail }) : failure("not_found");
});
