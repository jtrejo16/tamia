import { syncVoiceAgent } from "@empleado/inbox";
import { authed, respond } from "@/lib/api";
import { getDb, getRetell, publicBaseUrl } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Crea o actualiza el agente de este negocio en Retell. Solo dueño (lo valida el dominio). */
export const POST = authed(async (req, ctx) =>
  respond(
    await syncVoiceAgent(getDb(), getRetell(), ctx, {
      baseUrl: publicBaseUrl(req.nextUrl.origin),
      defaultVoiceId: process.env.RETELL_VOICE_ID?.trim() || undefined,
    }),
  ),
);
