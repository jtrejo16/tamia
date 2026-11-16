import { runVoiceTool, verifyRetellSignature } from "@empleado/inbox";
import { NextResponse, type NextRequest } from "next/server";
import { getDb, notifyChange } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Funciones del agente de voz (consultar horarios, agendar, escalar...). Retell llama aqui en medio de
 * la llamada. Solo con firma valida; el negocio sale del id del agente, nunca de lo que mande la peticion.
 */
export async function POST(req: NextRequest) {
  const apiKey = process.env.RETELL_API_KEY?.trim();
  if (!apiKey) return NextResponse.json({ error: "no_configurado" }, { status: 503 });

  const raw = await req.text();
  if (raw.length > 1_000_000) return NextResponse.json({ error: "demasiado_grande" }, { status: 413 });
  if (!verifyRetellSignature({ body: raw, apiKey, signature: req.headers.get("x-retell-signature") })) {
    return NextResponse.json({ error: "firma_invalida" }, { status: 401 });
  }

  let body: { name?: string; args?: unknown; call?: Record<string, unknown> };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "json_invalido" }, { status: 400 });
  }
  try {
    const result = await runVoiceTool(getDb(), { call: (body.call ?? {}) as never, name: String(body.name ?? ""), args: body.args });
    notifyChange();
    return NextResponse.json(result);
  } catch (error) {
    console.error("[voice] error en la funcion:", error instanceof Error ? error.message : error);
    // El agente debe poder seguir hablando: se le dice que hubo un problema, sin detalles tecnicos.
    return NextResponse.json({ error: "error_interno", instruccion: "Hubo un problema técnico. Discúlpate y pasa a una persona con escalar_a_humano." });
  }
}
