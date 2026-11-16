import { handleCallEvent, verifyRetellSignature } from "@empleado/inbox";
import { NextResponse, type NextRequest } from "next/server";
import { getDb, notifyChange } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Avisos de Retell (inicio, fin y analisis de cada llamada). Publica por naturaleza: se acepta SOLO con
 * firma valida (clave de API de Retell). Sin firma valida no se toca nada.
 */
export async function POST(req: NextRequest) {
  const apiKey = process.env.RETELL_API_KEY?.trim();
  if (!apiKey) return NextResponse.json({ ok: false }, { status: 503 });

  const raw = await req.text();
  if (raw.length > 2_000_000) return NextResponse.json({ ok: false }, { status: 413 });
  if (!verifyRetellSignature({ body: raw, apiKey, signature: req.headers.get("x-retell-signature") })) {
    console.warn("[voice] aviso con firma invalida");
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let payload: { event?: string; call?: Record<string, unknown> };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  try {
    const { handled } = await handleCallEvent(getDb(), { event: String(payload.event ?? ""), call: (payload.call ?? {}) as never });
    if (handled) notifyChange();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[voice] error en el aviso:", error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false }, { status: 500 }); // Retell reintenta
  }
}
