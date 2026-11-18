import {
  checkSocialChannels,
  checkWhatsAppConnection,
  connectChannel,
  disconnectChannel,
  disconnectSocial,
  logSupportAction,
  operatorSupportContext,
  syncTemplates,
  syncVoiceAgent,
  voiceCostSettings,
} from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed, failure, readJson, respond, str } from "@/lib/api";
import { socialDeps } from "@/lib/facebook";
import { UUID, graphDeps } from "@/lib/operator";
import { getDb, getRetell, publicBaseUrl } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Soporte: el operador actua en NOMBRE de un negocio (como su dueño), solo si la base confirma que es operador.
 * Cada accion deja constancia en la bitacora del negocio. Las claves que pegue el operador se guardan cifradas y
 * no vuelven a salir del servidor.
 *   whatsapp-connect | whatsapp-disconnect | social-disconnect | check | voice-sync | templates-sync
 */
export const POST = authed<{ action: string }>(async (req, ctx, { action }) => {
  const db = getDb();
  const body = await readJson(req);
  const tenantId = str(body.tenantId);
  if (!UUID.test(tenantId)) return failure("bad_request");
  const sctx = await operatorSupportContext(db, ctx.userId, tenantId);
  if (!sctx) return failure("forbidden");

  switch (action) {
    case "whatsapp-connect": {
      const r = await connectChannel(db, graphDeps(), sctx, { phoneNumberId: body.phoneNumberId, wabaId: body.wabaId, accessToken: body.accessToken });
      if (r.ok) await logSupportAction(db, sctx, "whatsapp_connect", { phoneNumberId: str(body.phoneNumberId) }); // nunca la clave
      return respond(r);
    }
    case "whatsapp-disconnect": {
      const r = await disconnectChannel(db, sctx);
      if (r.ok) await logSupportAction(db, sctx, "whatsapp_disconnect");
      return respond(r);
    }
    case "social-disconnect": {
      const r = await disconnectSocial(db, sctx, body.type);
      if (r.ok) await logSupportAction(db, sctx, "social_disconnect", { type: str(body.type) });
      return respond(r);
    }
    case "check": {
      const whatsapp = await checkWhatsAppConnection(db, graphDeps(), sctx);
      const sd = socialDeps();
      const social = sd ? await checkSocialChannels(db, sd, sctx) : null;
      await logSupportAction(db, sctx, "check");
      return NextResponse.json({ ok: true, whatsapp, social: social && social.ok ? social.checks : [], socialAvailable: sd !== null });
    }
    case "voice-sync": {
      const r = await syncVoiceAgent(db, getRetell(), sctx, { baseUrl: publicBaseUrl(req.nextUrl.origin), defaultVoiceId: process.env.RETELL_VOICE_ID?.trim() || undefined, economy: voiceCostSettings(process.env) });
      if (r.ok) await logSupportAction(db, sctx, "voice_sync");
      return respond(r);
    }
    case "templates-sync": {
      const r = await syncTemplates(db, graphDeps(), tenantId);
      if (r.ok) await logSupportAction(db, sctx, "templates_sync");
      return respond(r);
    }
  }
  return failure("not_found");
});
