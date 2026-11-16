import { listConversations, type ConversationFilter } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

const FILTERS = new Set<ConversationFilter>(["all", "attention", "bot", "human", "closed"]);

export const GET = authed(async (req, ctx) => {
  const params = req.nextUrl.searchParams;
  const filter = params.get("filter") as ConversationFilter | null;
  const items = await listConversations(getDb(), ctx, {
    filter: filter && FILTERS.has(filter) ? filter : "all",
    search: params.get("q")?.slice(0, 80) ?? undefined,
  });
  return NextResponse.json({ ok: true, items });
});
