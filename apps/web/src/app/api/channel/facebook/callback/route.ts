import { fetchPagesForCode } from "@empleado/inbox";
import { NextResponse, type NextRequest } from "next/server";
import { PAGES_COOKIE, pagesCookieOptions, sealPages, socialDeps, verifyState } from "@/lib/facebook";
import { publicBaseUrl } from "@/lib/server";
import { getValidSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Facebook regresa aqui con ?code=...&state=... */
export async function GET(req: NextRequest) {
  const base = publicBaseUrl(req.nextUrl.origin);
  const back = (code: string) => NextResponse.redirect(`${base}/configuracion?tab=redes&fb=${code}`);

  const valid = await getValidSession();
  if (!valid) return NextResponse.redirect(`${base}/login`);
  const deps = socialDeps();
  if (!deps || valid.ctx.role !== "owner") return back("forbidden");

  const params = req.nextUrl.searchParams;
  if (params.get("error")) return back("denied"); // el usuario cancelo
  const code = params.get("code");
  // El state debe ser el que firmamos para ESTE usuario y negocio, reciente.
  if (!code || !verifyState(params.get("state"), valid.session.uid, valid.session.tid)) return back("invalid");

  const result = await fetchPagesForCode(deps, { code, redirectUri: `${base}/api/channel/facebook/callback` });
  if (!result.ok) return back(result.error);

  const res = back("pick");
  res.cookies.set(PAGES_COOKIE, sealPages(valid.session.uid, valid.session.tid, result.pages), pagesCookieOptions);
  return res;
}
