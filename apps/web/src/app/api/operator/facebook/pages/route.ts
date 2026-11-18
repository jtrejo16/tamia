import { operatorSupportContext } from "@empleado/inbox";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authed, failure } from "@/lib/api";
import { OP_PAGES_COOKIE, openPages } from "@/lib/facebook";
import { UUID } from "@/lib/operator";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Soporte: paginas disponibles para conectar a un cliente. NUNCA incluye tokens: solo nombre y si tiene Instagram. */
export const GET = authed(async (req, ctx) => {
  const tenant = req.nextUrl.searchParams.get("tenant") ?? "";
  if (!UUID.test(tenant)) return failure("bad_request");
  if (!(await operatorSupportContext(getDb(), ctx.userId, tenant))) return failure("forbidden");
  const pages = openPages((await cookies()).get(OP_PAGES_COOKIE)?.value, ctx.userId, tenant);
  return NextResponse.json({
    ok: true,
    pages: (pages ?? []).map((p) => ({ pageId: p.pageId, name: p.name, instagram: p.instagram ? { username: p.instagram.username } : null })),
  });
});
