import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { PAGES_COOKIE, openPages } from "@/lib/facebook";

export const dynamic = "force-dynamic";

/** Paginas disponibles para elegir. NUNCA incluye tokens: solo nombre y si tiene Instagram. */
export const GET = authed(async (_req, ctx) => {
  const pages = openPages((await cookies()).get(PAGES_COOKIE)?.value, ctx.userId, ctx.tenantId);
  return NextResponse.json({
    ok: true,
    pages: (pages ?? []).map((p) => ({ pageId: p.pageId, name: p.name, instagram: p.instagram ? { username: p.instagram.username } : null })),
  });
});
