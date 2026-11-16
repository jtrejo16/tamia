import { WhatsAppApiError, isWithinServiceWindow } from "@empleado/channels";
import type { OutboundJobData } from "@empleado/channels";
import {
  channels,
  contacts,
  conversations,
  messages,
  withTenant,
  type Contact,
  type Conversation,
  type Database,
  type Message,
} from "@empleado/db";
import { and, asc, eq } from "drizzle-orm";
import { loadChannelAccess, type ChannelAccess } from "../channel-access";
import type { Logger } from "../config";
import type { Lock } from "../lock";

/** Lo minimo que el procesador necesita de un cliente de WhatsApp (facil de simular en pruebas). */
export interface Sender {
  sendText(to: string, body: string): Promise<{ wamid: string }>;
  sendLocation(
    to: string,
    location: { latitude: number; longitude: number; name?: string; address?: string },
  ): Promise<{ wamid: string }>;
}

export interface OutboundDeps {
  db: Database;
  /** Llave AES-256 para descifrar los tokens de los canales. */
  key: Buffer;
  makeSender(access: { accessToken: string; phoneNumberId: string }): Sender;
  lock: Lock;
  now?: () => Date;
  log?: Logger;
}

export interface Attempt {
  attempt: number;
  maxAttempts: number;
}

export type OutboundResult =
  | { status: "processed"; sent: string[]; failed: string[] }
  | { status: "skipped"; reason: "not_found" | "already_processed" };

const fail = (text: string) => text.slice(0, 300);

/**
 * Envia los mensajes salientes de una conversacion EN ORDEN (primero el texto, luego la
 * ubicacion). Es idempotente: un mensaje que ya no esta "queued" no se vuelve a enviar.
 */
export function createOutboundProcessor(deps: OutboundDeps) {
  const log = deps.log ?? (() => {});

  async function mark(tenantId: string, messageId: string, patch: Partial<Pick<Message, "status" | "error" | "externalId">>) {
    await withTenant(deps.db, { tenantId }, (tx) =>
      tx.update(messages).set({ ...patch, updatedAt: new Date() }).where(eq(messages.id, messageId)),
    );
  }

  async function sendOne(
    m: Message,
    ctx: { tenantId: string; conversation: Conversation; contact: Contact; access: ChannelAccess | null; attempt: Attempt },
  ): Promise<"sent" | "failed"> {
    const { tenantId, conversation, contact, access, attempt } = ctx;
    const now = deps.now?.() ?? new Date();

    if (!isWithinServiceWindow(conversation.lastInboundAt, now)) {
      await mark(tenantId, m.id, { status: "failed", error: "fuera_de_ventana_24h: solo se pueden enviar plantillas" });
      return "failed";
    }
    if (!access || !access.accessToken) {
      await mark(tenantId, m.id, { status: "failed", error: "sin_credenciales: el canal no tiene token de WhatsApp" });
      return "failed";
    }
    if (!contact.phoneE164) {
      await mark(tenantId, m.id, { status: "failed", error: "sin_telefono: el contacto no tiene numero" });
      return "failed";
    }

    const to = contact.phoneE164.replace(/\D/g, "");
    const sender = deps.makeSender({ accessToken: access.accessToken, phoneNumberId: access.phoneNumberId });

    try {
      let wamid: string;
      if (m.type === "text") {
        wamid = (await sender.sendText(to, m.body ?? "")).wamid;
      } else if (m.type === "location") {
        const loc = JSON.parse(m.body ?? "{}") as {
          name?: string;
          address?: string;
          latitude?: number;
          longitude?: number;
          mapsUrl?: string;
        };
        if (typeof loc.latitude === "number" && typeof loc.longitude === "number") {
          wamid = (
            await sender.sendLocation(to, {
              latitude: loc.latitude,
              longitude: loc.longitude,
              name: loc.name,
              address: loc.address,
            })
          ).wamid;
        } else {
          // Sin coordenadas: se manda la direccion y el enlace del mapa como texto.
          const text = [loc.name, loc.address, loc.mapsUrl].filter(Boolean).join("\n");
          wamid = (await sender.sendText(to, text || "Nuestra ubicación")).wamid;
        }
      } else {
        await mark(tenantId, m.id, { status: "failed", error: `tipo_no_soportado: ${m.type}` });
        return "failed";
      }

      await withTenant(deps.db, { tenantId }, async (tx) => {
        await tx
          .update(messages)
          .set({ externalId: wamid, status: "sent", error: null, updatedAt: new Date() })
          .where(eq(messages.id, m.id));
        await tx
          .update(conversations)
          .set({ lastMessageAt: now, updatedAt: now })
          .where(eq(conversations.id, conversation.id));
      });
      return "sent";
    } catch (error) {
      if (!(error instanceof WhatsAppApiError)) throw error; // base de datos, etc.: BullMQ reintenta

      if (error.retryable) {
        if (attempt.attempt < attempt.maxAttempts) {
          log("outbound.retry", { messageId: m.id, kind: error.kind, attempt: attempt.attempt });
          throw error; // el mensaje sigue "queued"; BullMQ reintenta con espera
        }
        await mark(tenantId, m.id, { status: "failed", error: fail(`reintentos_agotados: ${error.message}`) });
        return "failed";
      }

      await mark(tenantId, m.id, { status: "failed", error: fail(`${error.kind}: ${error.message}`) });
      if (error.kind === "auth") {
        // Token vencido o revocado: se marca el canal para que el panel avise y no se sigan
        // intentando envios que fallaran todos.
        await withTenant(deps.db, { tenantId }, (tx) =>
          tx.update(channels).set({ status: "error", updatedAt: new Date() }).where(eq(channels.id, access.channelId)),
        );
        log("outbound.channel_auth_error", { tenantId, channelId: access.channelId });
      }
      return "failed";
    }
  }

  return async (data: OutboundJobData, attempt: Attempt = { attempt: 1, maxAttempts: 1 }): Promise<OutboundResult> => {
    const { tenantId, messageId } = data;

    const [first] = await withTenant(deps.db, { tenantId }, (tx) =>
      tx.select().from(messages).where(eq(messages.id, messageId)),
    );
    if (!first || first.direction !== "out") return { status: "skipped", reason: "not_found" };
    if (first.status !== "queued") return { status: "skipped", reason: "already_processed" };

    return deps.lock.withLock(`out:${first.conversationId}`, async () => {
      const loaded = await withTenant(deps.db, { tenantId }, async (tx) => {
        const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, first.conversationId));
        const [contact] = conversation
          ? await tx.select().from(contacts).where(eq(contacts.id, conversation.contactId))
          : [];
        const pending = await tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, first.conversationId),
              eq(messages.direction, "out"),
              eq(messages.status, "queued"),
            ),
          )
          .orderBy(asc(messages.createdAt), asc(messages.type))
          .limit(10);
        return { conversation, contact, pending };
      });
      if (!loaded.conversation || !loaded.contact) {
        await mark(tenantId, first.id, { status: "failed", error: "conversacion_no_encontrada" });
        return { status: "processed" as const, sent: [], failed: [first.id] };
      }

      const access = await loadChannelAccess(deps.db, deps.key, tenantId, first.channelId);
      const sent: string[] = [];
      const failed: string[] = [];
      for (const m of loaded.pending) {
        const outcome = await sendOne(m, {
          tenantId,
          conversation: loaded.conversation,
          contact: loaded.contact,
          access,
          attempt,
        });
        (outcome === "sent" ? sent : failed).push(m.id);
      }
      log("outbound.processed", { tenantId, conversationId: first.conversationId, sent: sent.length, failed: failed.length });
      return { status: "processed" as const, sent, failed };
    });
  };
}
