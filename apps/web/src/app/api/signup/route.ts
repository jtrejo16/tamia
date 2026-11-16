import { signup } from "@empleado/inbox";
import { NextResponse, type NextRequest } from "next/server";
import { failure, readJson, respond, sameOrigin } from "@/lib/api";
import { getDb, getLimiter } from "@/lib/server";
import { startSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Registro publico: crea el negocio (pendiente de aprobacion) y deja la sesion iniciada. */
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return failure("bad_origin");

  // Freno de abuso: pocos registros por IP por hora (cada uno crea datos y puede costar IA).
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    if (!(await getLimiter().allow(`signup-ip:${ip}`, 5, 3600))) return failure("rate_limited");
  } catch (error) {
    console.error("[signup] limitador no disponible:", error instanceof Error ? error.message : error);
  }

  const result = await signup(getDb(), await readJson(req));
  if (!result.ok) return respond(result);

  await startSession({ uid: result.userId, tid: result.tenantId, sv: result.sessionVersion });
  return NextResponse.json({ ok: true });
}
