import type { InboundMessage } from "../whatsapp/types";

/** Canales que usan la Messenger Platform de Meta (identifican al cliente por un id propio, sin telefono). */
export type SocialChannelType = "messenger" | "instagram";
export const isSocialChannel = (v: unknown): v is SocialChannelType => v === "messenger" || v === "instagram";

export interface SocialInbound {
  channelType: SocialChannelType;
  /** Id de la pagina (Messenger) o de la cuenta de Instagram que recibio el mensaje: mapea al negocio. */
  accountId: string;
  /** PSID / IGSID del cliente. */
  senderId: string;
  message: InboundMessage;
}

export interface ParsedSocialWebhook {
  messages: SocialInbound[];
  /** Ecos propios, lecturas, entregas, reacciones y demas eventos sin accion. */
  ignored: number;
}

type Attachment = { type?: string; payload?: { url?: string; coordinates?: { lat?: number; long?: number } } };
type MessagingEvent = {
  sender?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    quick_reply?: { payload?: string };
    attachments?: Attachment[];
  };
  postback?: { mid?: string; title?: string; payload?: string };
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Texto que el agente "lee" cuando el cliente manda algo que no se puede procesar. */
const unsupported = (kind: string) => `[El cliente envió un archivo (${kind}) que no puedo ver. Pídele que lo describa con texto.]`;

function normalize(event: MessagingEvent): InboundMessage | null {
  const seconds = Math.floor((event.timestamp ?? Date.now()) / 1000);
  const from = event.sender?.id;
  if (!from) return null;

  if (event.postback) {
    const payload = event.postback.payload ?? "";
    if (!payload && !event.postback.title) return null;
    return {
      id: event.postback.mid ?? `pb-${from}-${event.timestamp ?? seconds}`,
      from,
      timestamp: seconds,
      type: "interactive",
      text: event.postback.title ?? payload,
      replyPayload: payload,
    };
  }

  const m = event.message;
  if (!m?.mid || m.is_echo) return null;

  const base = { id: m.mid, from, timestamp: seconds };
  if (m.quick_reply?.payload) {
    return { ...base, type: "interactive", text: m.text ?? "", replyPayload: m.quick_reply.payload };
  }

  const first = m.attachments?.[0];
  if (first) {
    const url = first.payload?.url;
    const caption = m.text ?? "";
    switch (first.type) {
      case "image":
        return { ...base, type: "image", text: caption, mediaUrl: url };
      case "audio":
        return { ...base, type: "audio", text: caption, mediaUrl: url };
      case "file":
        return { ...base, type: "document", text: caption, mediaUrl: url };
      case "location": {
        const lat = first.payload?.coordinates?.lat;
        const long = first.payload?.coordinates?.long;
        if (typeof lat === "number" && typeof long === "number") {
          return { ...base, type: "location", text: caption, location: { latitude: lat, longitude: long } };
        }
        return { ...base, type: "text", text: unsupported("ubicación") };
      }
      default:
        // video, share, story_mention, reel, fallback...: si ademas escribio algo, se conserva el texto.
        return { ...base, type: "text", text: caption || unsupported(first.type ?? "adjunto") };
    }
  }

  const text = (m.text ?? "").trim();
  return text ? { ...base, type: "text", text } : null;
}

/** Interpreta el POST del webhook de Meta cuando `object` es "page" (Messenger) o "instagram". */
export function parseSocialWebhook(json: unknown): ParsedSocialWebhook {
  const out: ParsedSocialWebhook = { messages: [], ignored: 0 };
  if (!isRecord(json)) return out;
  const channelType: SocialChannelType | null = json.object === "page" ? "messenger" : json.object === "instagram" ? "instagram" : null;
  if (!channelType || !Array.isArray(json.entry)) return out;

  for (const entry of json.entry) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    const events: unknown[] = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const raw of events) {
      const message = isRecord(raw) ? normalize(raw as MessagingEvent) : null;
      if (message) out.messages.push({ channelType, accountId: entry.id, senderId: message.from, message });
      else out.ignored++;
    }
  }
  return out;
}

/** Objetos del webhook que atiende este parser. */
export const isSocialWebhookObject = (v: unknown): boolean => v === "page" || v === "instagram";
