import type { InboundMessage, ParsedWebhook, StatusEvent, StoredMessageType } from "./types";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

function normalizeMessage(raw: Obj): InboundMessage | null {
  const id = str(raw.id);
  const from = str(raw.from);
  if (!id || !from) return null;
  const base = { id, from, timestamp: num(raw.timestamp) ?? Math.floor(Date.now() / 1000) };
  const kind = str(raw.type);

  const media = (key: string, type: StoredMessageType, fallbackText: string): InboundMessage => {
    const m = isObj(raw[key]) ? raw[key] : {};
    return {
      ...base,
      type,
      text: str(m.caption) ?? str(m.filename) ?? fallbackText,
      mediaId: str(m.id),
      mimeType: str(m.mime_type),
    };
  };

  switch (kind) {
    case "text": {
      const body = isObj(raw.text) ? str(raw.text.body) : undefined;
      return body ? { ...base, type: "text", text: body } : null;
    }
    case "image":
      return media("image", "image", "");
    case "audio":
      return media("audio", "audio", "");
    case "document":
      return media("document", "document", "");
    case "video":
      return media("video", "document", "[El cliente envió un video]");
    case "sticker":
      return media("sticker", "document", "[El cliente envió un sticker]");
    case "location": {
      const l = isObj(raw.location) ? raw.location : {};
      const latitude = num(l.latitude);
      const longitude = num(l.longitude);
      if (latitude === undefined || longitude === undefined) return null;
      const name = str(l.name);
      const address = str(l.address);
      return {
        ...base,
        type: "location",
        text: ["Ubicación compartida", name, address, `(${latitude}, ${longitude})`].filter(Boolean).join(" · "),
        location: { latitude, longitude, name, address },
      };
    }
    case "interactive": {
      const i = isObj(raw.interactive) ? raw.interactive : {};
      const reply = isObj(i.button_reply) ? i.button_reply : isObj(i.list_reply) ? i.list_reply : undefined;
      const title = reply ? str(reply.title) : undefined;
      return title ? { ...base, type: "interactive", text: title, replyPayload: str(reply?.id) } : null;
    }
    case "button": {
      // Respuesta rapida de una plantilla (por ejemplo "Confirmo" / "Reagendar").
      const b = isObj(raw.button) ? raw.button : {};
      const text = str(b.text);
      return text ? { ...base, type: "interactive", text, replyPayload: str(b.payload) } : null;
    }
    default:
      // reaction, contacts, order, system, unsupported...: no generan respuesta.
      return null;
  }
}

function normalizeStatus(raw: Obj): StatusEvent | null {
  const id = str(raw.id);
  const status = str(raw.status);
  if (!id || (status !== "sent" && status !== "delivered" && status !== "read" && status !== "failed")) {
    return null;
  }
  const error = isObj(arr(raw.errors)[0]) ? (arr(raw.errors)[0] as Obj) : undefined;
  const p = isObj(raw.pricing) ? raw.pricing : undefined;
  const category = p ? str(p.category) : undefined;
  return {
    id,
    status,
    recipientId: str(raw.recipient_id),
    timestamp: num(raw.timestamp) ?? Math.floor(Date.now() / 1000),
    ...(p && category && typeof p.billable === "boolean" ? { pricing: { billable: p.billable, category, ...(str(p.type) ? { type: str(p.type)! } : {}) } } : {}),
    ...(error
      ? { errorCode: num(error.code), errorTitle: str(error.title), errorMessage: str(error.message) }
      : {}),
  };
}

/** Convierte el JSON crudo de Meta en eventos simples. Tolera campos desconocidos. */
export function parseWebhookPayload(json: unknown): ParsedWebhook {
  const out: ParsedWebhook = { messages: [], statuses: [], ignored: 0 };
  if (!isObj(json) || json.object !== "whatsapp_business_account") return out;

  for (const entry of arr(json.entry)) {
    if (!isObj(entry)) continue;
    for (const change of arr(entry.changes)) {
      if (!isObj(change)) continue;
      if (change.field !== "messages" || !isObj(change.value)) {
        out.ignored++;
        continue;
      }
      const value = change.value;
      const phoneNumberId = isObj(value.metadata) ? str(value.metadata.phone_number_id) : undefined;
      if (!phoneNumberId) {
        out.ignored++;
        continue;
      }

      const names = new Map<string, string>();
      for (const c of arr(value.contacts)) {
        if (!isObj(c)) continue;
        const waId = str(c.wa_id);
        const name = isObj(c.profile) ? str(c.profile.name) : undefined;
        if (waId && name) names.set(waId, name);
      }

      for (const m of arr(value.messages)) {
        const message = isObj(m) ? normalizeMessage(m) : null;
        if (message) {
          out.messages.push({ phoneNumberId, contactName: names.get(message.from), message });
        } else {
          out.ignored++;
        }
      }
      for (const s of arr(value.statuses)) {
        const status = isObj(s) ? normalizeStatus(s) : null;
        if (status) out.statuses.push({ phoneNumberId, status });
        else out.ignored++;
      }
    }
  }
  return out;
}
