import { authenticate } from "@empleado/inbox";
import { NextResponse, type NextRequest } from "next/server";
import { failure, readJson, sameOrigin, str } from "@/lib/api";
import { getDb, getLimiter } from "@/lib/server";
import { startSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return failure("bad_origin");

  const body = await readJson(req);
  const email = str(body.email).trim().toLowerCase();
  const password = str(body.password);
  if (!email || !password || email.length > 200 || password.length > 200) return failure("invalid_credentials");

  // Freno a la fuerza bruta: por IP y por correo. Si Redis falla, no se bloquea el acceso.
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const limiter = getLimiter();
    const okIp = await limiter.allow(`login-ip:${ip}`, 30, 900);
    const okEmail = await limiter.allow(`login-email:${email}`, 8, 900);
    if (!okIp || !okEmail) return failure("rate_limited");
  } catch (error) {
    console.error("[login] limitador no disponible:", error instanceof Error ? error.message : error);
  }

  const result = await authenticate(getDb(), email, password);
  if (!result.ok) return failure(result.error);

  await startSession({ uid: result.login.userId, tid: result.login.tenantId, sv: result.login.sessionVersion });
  return NextResponse.json({ ok: true, mustChangePassword: result.login.mustChangePassword });
}
