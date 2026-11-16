import { WhatsAppApiError, type SendFailureKind } from "../whatsapp/client";
import type { SocialChannelType } from "./payload";

/** Limite de caracteres por mensaje de texto en cada red. */
export const SOCIAL_TEXT_LIMIT: Record<SocialChannelType, number> = { messenger: 2000, instagram: 1000 };

/** Parte un texto largo en trozos que respeten el limite, cortando en parrafo, linea u oracion. */
export function splitForChannel(text: string, limit: number): string[] {
  const clean = text.trim();
  if (clean.length <= limit) return [clean];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Mejor corte posible dentro de la segunda mitad del trozo (no dejar trozos diminutos).
    const floor = Math.floor(limit / 2);
    let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
    if (cut < floor) cut = window.lastIndexOf(" ");
    if (cut < floor) cut = limit - 1;
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

/** Traduce el error de la Graph API (Messenger/Instagram) a una categoria accionable. */
export function classifySocialError(status: number | undefined, code: number | undefined, subcode: number | undefined): SendFailureKind {
  if (status === 401 || code === 190 || code === 102) return "auth";
  // Fuera de la ventana de 24 h (o sin permiso para escribir primero).
  if ((code === 10 && subcode === 2018278) || code === 551 || (code === 10 && subcode === 2534022)) return "window";
  if (code === 100 && subcode === 2018001) return "recipient"; // el cliente no existe / bloqueo
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80006 || status === 429) return "rate";
  if (status === undefined || status >= 500 || code === 1 || code === 2) return "server";
  return "other";
}

export interface SocialClientOptions {
  accessToken: string;
  /** Id de la pagina (Messenger) o de la cuenta profesional de Instagram. */
  accountId: string;
  channelType: SocialChannelType;
  apiVersion?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Envio por Messenger / Instagram. Implementa la misma forma que el cliente de WhatsApp
 * (`wamid` = id del mensaje en Meta) para que el procesador de salida sea uno solo.
 */
export class SocialClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: SocialClientOptions) {
    if (!options.accessToken) throw new Error("Falta el token de acceso de la pagina");
    if (!options.accountId) throw new Error("Falta el id de la pagina o cuenta");
    this.base = `${(options.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "")}/${options.apiVersion ?? "v23.0"}`;
    this.doFetch = options.fetch ?? fetch;
  }

  /** Envia texto (partido si excede el limite de la red). Devuelve el id del ultimo trozo. */
  async sendText(to: string, body: string): Promise<{ wamid: string }> {
    const parts = splitForChannel(body, SOCIAL_TEXT_LIMIT[this.options.channelType]);
    let last = "";
    for (const part of parts) last = (await this.post({ recipient: { id: to }, messaging_type: "RESPONSE", message: { text: part } })).message_id;
    return { wamid: last };
  }

  /** Estas redes no tienen mensaje de ubicacion enviable: se manda como texto con el enlace del mapa. */
  async sendLocation(
    to: string,
    location: { latitude: number; longitude: number; name?: string; address?: string },
  ): Promise<{ wamid: string }> {
    const map = `https://maps.google.com/?q=${location.latitude},${location.longitude}`;
    return this.sendText(to, [location.name, location.address, map].filter(Boolean).join("\n"));
  }

  /** Las plantillas son de WhatsApp: aqui no existen. */
  async sendTemplate(): Promise<{ wamid: string }> {
    throw new WhatsAppApiError("Las plantillas solo existen en WhatsApp", { kind: "other" });
  }

  private async post(payload: unknown): Promise<{ message_id: string }> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.base}/${encodeURIComponent(this.options.accountId)}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new WhatsAppApiError(`Fallo de red con Meta (${e instanceof Error ? e.name : "error"})`, { kind: "server" });
    }
    const raw = await response.text();
    let json: { message_id?: string; error?: { message?: string; code?: number; error_subcode?: number; error_user_msg?: string } } = {};
    try {
      json = JSON.parse(raw);
    } catch {
      /* no JSON */
    }
    if (!response.ok || json.error) {
      const code = json.error?.code;
      const subcode = json.error?.error_subcode;
      throw new WhatsAppApiError(
        `Meta rechazo el envio (HTTP ${response.status}${code ? `, codigo ${code}` : ""}): ${json.error?.error_user_msg ?? json.error?.message ?? "sin detalle"}`,
        { status: response.status, code, subcode, kind: classifySocialError(response.status, code, subcode) },
      );
    }
    if (!json.message_id) throw new WhatsAppApiError("Meta no devolvio el id del mensaje", { kind: "other" });
    return { message_id: json.message_id };
  }
}
