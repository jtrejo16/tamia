import { isSocialWebhookObject, parseSocialWebhook, type SocialChannelType } from "../social/payload";
import { parseWebhookPayload } from "./payload";
import { verifySignature } from "./signature";
import type { InboundJobData, StatusJobData } from "./types";

export const MAX_WEBHOOK_BYTES = 1_000_000;

export interface WebhookDeps {
  /** Texto que TU inventas; Meta lo manda al verificar la URL (hub.verify_token). */
  verifyToken: string;
  /** App Secret de la app de Meta: firma cada POST. */
  appSecret: string;
  /** phone_number_id -> negocio/canal. Nulo si el numero no esta registrado en el sistema. */
  resolveChannel(phoneNumberId: string): Promise<{ tenantId: string; channelId: string } | null>;
  /** (tipo, id de la pagina o cuenta) -> negocio/canal. Si falta, Messenger e Instagram se ignoran. */
  resolveSocialChannel?(type: SocialChannelType, accountId: string): Promise<{ tenantId: string; channelId: string } | null>;
  enqueueInbound(job: InboundJobData): Promise<void>;
  enqueueStatus(job: StatusJobData): Promise<void>;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface WebhookHandlers {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
}

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/**
 * Manejadores del webhook de WhatsApp con la API estandar Request/Response: sirven igual en
 * una ruta de Next.js (`export const { GET, POST } = ...`) o en un servidor Node.
 *
 * Regla de oro: responder 200 en menos de ~1 s. Aqui solo se valida, se clasifica y se
 * encola; el trabajo pesado (IA, envio) lo hace el worker.
 */
export function createWhatsAppWebhook(deps: WebhookDeps): WebhookHandlers {
  const log = deps.log ?? (() => {});

  return {
    // Verificacion de la URL cuando se configura el webhook en Meta.
    async GET(request) {
      const params = new URL(request.url).searchParams;
      const mode = params.get("hub.mode");
      const token = params.get("hub.verify_token");
      const challenge = params.get("hub.challenge");
      if (mode === "subscribe" && token !== null && token === deps.verifyToken && challenge !== null) {
        log("webhook.verified");
        return text(challenge, 200);
      }
      log("webhook.verify_rejected");
      return text("Forbidden", 403);
    },

    async POST(request) {
      const declared = Number(request.headers.get("content-length") ?? 0);
      if (declared > MAX_WEBHOOK_BYTES) return text("Payload too large", 413);

      const raw = await request.text();
      if (raw.length > MAX_WEBHOOK_BYTES) return text("Payload too large", 413);

      // 1) Autenticidad: sin firma valida no se toca nada.
      if (!verifySignature(raw, request.headers.get("x-hub-signature-256"), deps.appSecret)) {
        log("webhook.bad_signature");
        return text("Invalid signature", 401);
      }

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return text("Bad request", 400);
      }

      // Messenger e Instagram llegan por el mismo webhook, con otro "object".
      if (isSocialWebhookObject((json as { object?: unknown } | null)?.object)) {
        if (!deps.resolveSocialChannel) return text("OK", 200);
        const social = parseSocialWebhook(json);
        try {
          for (const item of social.messages) {
            const channel = await deps.resolveSocialChannel(item.channelType, item.accountId);
            if (!channel) {
              log("webhook.unknown_account", { channelType: item.channelType, accountId: item.accountId });
              continue;
            }
            await deps.enqueueInbound({
              tenantId: channel.tenantId,
              channelId: channel.channelId,
              channelType: item.channelType,
              phoneNumberId: item.accountId,
              message: item.message,
            });
          }
        } catch (error) {
          log("webhook.enqueue_failed", { error: error instanceof Error ? error.message : String(error) });
          return text("Temporary error", 500);
        }
        log("webhook.accepted", { channelType: (json as { object: string }).object, messages: social.messages.length, ignored: social.ignored });
        return text("OK", 200);
      }

      // 2) Clasificar y encolar. Un error al encolar devuelve 500 para que Meta REINTENTE.
      const parsed = parseWebhookPayload(json);
      const cache = new Map<string, { tenantId: string; channelId: string } | null>();
      const resolve = async (phoneNumberId: string) => {
        if (!cache.has(phoneNumberId)) cache.set(phoneNumberId, await deps.resolveChannel(phoneNumberId));
        return cache.get(phoneNumberId)!;
      };

      try {
        for (const item of parsed.messages) {
          const channel = await resolve(item.phoneNumberId);
          if (!channel) {
            log("webhook.unknown_number", { phoneNumberId: item.phoneNumberId });
            continue;
          }
          await deps.enqueueInbound({
            tenantId: channel.tenantId,
            channelId: channel.channelId,
            phoneNumberId: item.phoneNumberId,
            contactName: item.contactName,
            message: item.message,
          });
        }
        for (const item of parsed.statuses) {
          const channel = await resolve(item.phoneNumberId);
          if (!channel) continue;
          await deps.enqueueStatus({
            tenantId: channel.tenantId,
            channelId: channel.channelId,
            status: item.status,
          });
        }
      } catch (error) {
        log("webhook.enqueue_failed", { error: error instanceof Error ? error.message : String(error) });
        return text("Temporary error", 500);
      }

      log("webhook.accepted", {
        messages: parsed.messages.length,
        statuses: parsed.statuses.length,
        ignored: parsed.ignored,
      });
      return text("OK", 200);
    },
  };
}
