import { buildFacebookLoginUrl } from "@empleado/inbox";
import { NextResponse, type NextRequest } from "next/server";
import { makeState, socialDeps } from "@/lib/facebook";
import { publicBaseUrl } from "@/lib/server";
import { getValidSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Inicia "Iniciar sesion con Facebook" (solo dueño): redirige a Facebook con un state firmado. */
export async function GET(req: NextRequest) {
  const base = publicBaseUrl(req.nextUrl.origin);
  const back = (code: string) => NextResponse.redirect(`${base}/configuracion?tab=redes&fb=${code}`);

  const valid = await getValidSession();
  if (!valid) return NextResponse.redirect(`${base}/login`);
  if (valid.ctx.role !== "owner") return back("forbidden");
  const deps = socialDeps();
  if (!deps) return back("unavailable");

  const url = buildFacebookLoginUrl(deps, {
    redirectUri: `${base}/api/channel/facebook/callback`,
    state: makeState(valid.session.uid, valid.session.tid),
  });
  return NextResponse.redirect(url);
}
