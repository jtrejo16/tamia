import { connectGoogleCalendar } from "@empleado/inbox";
import { NextResponse, type NextRequest } from "next/server";
import { verifyState } from "@/lib/facebook";
import { GOOGLE_STATE_PURPOSE, googleDeps } from "@/lib/google";
import { getDb, publicBaseUrl } from "@/lib/server";
import { getValidSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Google regresa aqui con ?code=...&state=... */
export async function GET(req: NextRequest) {
  const base = publicBaseUrl(req.nextUrl.origin);
  const back = (code: string) => NextResponse.redirect(`${base}/configuracion?tab=calendario&gc=${code}`);

  const valid = await getValidSession();
  if (!valid) return NextResponse.redirect(`${base}/login`);
  const deps = googleDeps();
  if (!deps || valid.ctx.role !== "owner") return back("forbidden");

  const params = req.nextUrl.searchParams;
  if (params.get("error")) return back("denied"); // la persona cancelo o no dio el permiso
  const code = params.get("code");
  // El state debe ser el que firmamos para ESTE usuario y negocio, reciente (evita que otro complete tu conexion).
  if (!code || !verifyState(params.get("state"), valid.session.uid, valid.session.tid, GOOGLE_STATE_PURPOSE)) {
    console.error("[google-calendar] callback invalido: falta el codigo o el state no coincide con tu sesion");
    return back("invalid");
  }

  const res = await connectGoogleCalendar(getDb(), deps, valid.ctx, { code, redirectUri: `${base}/api/calendar/google/callback` });
  if (!res.ok) {
    console.error(`[google-calendar] no se pudo conectar: ${res.error}`);
    return back(res.error);
  }
  return back("ok");
}
