import { buildFacebookLoginUrl, operatorSupportContext } from "@empleado/inbox";
import { NextResponse, type NextRequest } from "next/server";
import { makeOperatorState, socialDeps } from "@/lib/facebook";
import { UUID } from "@/lib/operator";
import { getDb, publicBaseUrl } from "@/lib/server";
import { getValidSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Soporte: el operador inicia "Iniciar sesion con Facebook" para conectar la pagina de UN cliente. Debe usar una
 * cuenta de Facebook que administre esa pagina (el cliente le da el rol en Meta). Mismo redireccionamiento OAuth
 * que el flujo normal; el state firmado lleva el negocio.
 */
export async function GET(req: NextRequest) {
  const base = publicBaseUrl(req.nextUrl.origin);
  const tenant = req.nextUrl.searchParams.get("tenant") ?? "";
  const back = (code: string) => NextResponse.redirect(`${base}/operador${UUID.test(tenant) ? `/${tenant}` : ""}?fb=${code}`);

  const valid = await getValidSession();
  if (!valid) return NextResponse.redirect(`${base}/login`);
  if (!UUID.test(tenant) || !(await operatorSupportContext(getDb(), valid.session.uid, tenant))) return back("forbidden");
  const deps = socialDeps();
  if (!deps) return back("unavailable");

  return NextResponse.redirect(
    buildFacebookLoginUrl(deps, { redirectUri: `${base}/api/channel/facebook/callback`, state: makeOperatorState(valid.session.uid, tenant) }),
  );
}
