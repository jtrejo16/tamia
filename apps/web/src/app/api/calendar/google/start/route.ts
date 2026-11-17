import { buildGoogleAuthUrl } from "@empleado/inbox";
import { NextResponse, type NextRequest } from "next/server";
import { makeState } from "@/lib/facebook";
import { GOOGLE_STATE_PURPOSE, googleDeps } from "@/lib/google";
import { publicBaseUrl } from "@/lib/server";
import { getValidSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Inicia "Conectar Google Calendar" (solo dueño): redirige a Google con un state firmado. */
export async function GET(req: NextRequest) {
  const base = publicBaseUrl(req.nextUrl.origin);
  const back = (code: string) => NextResponse.redirect(`${base}/configuracion?tab=calendario&gc=${code}`);

  const valid = await getValidSession();
  if (!valid) return NextResponse.redirect(`${base}/login`);
  if (valid.ctx.role !== "owner") return back("forbidden");
  const deps = googleDeps();
  if (!deps) return back("unavailable");

  return NextResponse.redirect(
    buildGoogleAuthUrl(deps, {
      redirectUri: `${base}/api/calendar/google/callback`,
      state: makeState(valid.session.uid, valid.session.tid, GOOGLE_STATE_PURPOSE),
    }),
  );
}
