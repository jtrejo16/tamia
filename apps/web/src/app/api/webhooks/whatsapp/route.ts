import { createWhatsAppWebhook } from "@empleado/channels";
import { resolveChannel } from "@empleado/db";
import { env, getDb, getEnqueue } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Webhook de Meta para WhatsApp, Messenger e Instagram en el panel: una sola direccion publica
 * sirve para todo. Hace lo mismo que el servidor del worker: valida la firma (sin firma valida no se
 * toca nada), identifica al negocio y ENCOLA; la IA y el envio los hace el worker.
 *
 * URL en Meta: https://TU-DOMINIO/api/webhooks/whatsapp  (el mismo token de verificacion de siempre).
 */
function handlers() {
  const enqueue = getEnqueue();
  return createWhatsAppWebhook({
    verifyToken: env("WHATSAPP_VERIFY_TOKEN"),
    appSecret: env("META_APP_SECRET"),
    resolveChannel: (phoneNumberId) => resolveChannel(getDb(), "whatsapp", phoneNumberId),
    resolveSocialChannel: (type, accountId) => resolveChannel(getDb(), type, accountId),
    enqueueInbound: enqueue.inbound,
    enqueueStatus: enqueue.status,
    log: (event, data) => console.log(`[webhook] ${event}`, data ?? ""),
  });
}

export async function GET(req: Request) {
  return handlers().GET(req);
}

export async function POST(req: Request) {
  return handlers().POST(req);
}
