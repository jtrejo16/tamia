import { fetchPagesForCode, operatorSupportContext } from "@empleado/inbox";
import { NextResponse, type NextRequest } from "next/server";
import { OP_PAGES_COOKIE, PAGES_COOKIE, opPagesCookieOptions, pagesCookieOptions, readOperatorState, sealPages, socialDeps, verifyState } from "@/lib/facebook";
import { getDb, publicBaseUrl } from "@/lib/server";
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
  const params = req.nextUrl.searchParams;

  // Soporte: el operador conecta la pagina de un cliente. El state lleva el negocio y solo lo acepta quien lo creo.
  const opTenant = readOperatorState(params.get("state"), valid.session.uid);
  if (opTenant) {
    const backOp = (code: string) => NextResponse.redirect(`${base}/operador/${opTenant}?fb=${code}`);
    if (!deps || !(await operatorSupportContext(getDb(), valid.session.uid, opTenant))) return backOp("forbidden");
    if (params.get("error")) return backOp("denied");
    const code = params.get("code");
    if (!code) return backOp("invalid");
    const result = await fetchPagesForCode(deps, { code, redirectUri: `${base}/api/channel/facebook/callback` });
    if (!result.ok) {
      console.error(`[facebook] callback (soporte) fallo: ${result.error}${result.detail ? ` (${result.detail})` : ""}`);
      return backOp(result.error);
    }
    const res = backOp("pick");
    res.cookies.set(OP_PAGES_COOKIE, sealPages(valid.session.uid, opTenant, result.pages), opPagesCookieOptions);
    return res;
  }

  if (!deps || valid.ctx.role !== "owner") return back("forbidden");
  if (params.get("error")) {
    console.error(`[facebook] Facebook devolvio error: ${params.get("error")} / ${params.get("error_description") ?? ""}`);
    return back("denied"); // el usuario cancelo
  }
  const code = params.get("code");
  // El state debe ser el que firmamos para ESTE usuario y negocio, reciente.
  if (!code || !verifyState(params.get("state"), valid.session.uid, valid.session.tid)) {
    console.error("[facebook] callback invalido: falta el codigo o el state no coincide con tu sesion");
    return back("invalid");
  }

  const result = await fetchPagesForCode(deps, { code, redirectUri: `${base}/api/channel/facebook/callback` });
  if (!result.ok) {
    console.error(`[facebook] callback fallo: ${result.error}${result.detail ? ` (${result.detail})` : ""}`);
    return back(result.error);
  }

  const res = back("pick");
  res.cookies.set(PAGES_COOKIE, sealPages(valid.session.uid, valid.session.tid, result.pages), pagesCookieOptions);
  return res;
}
