/** Cliente minimo de la WhatsApp Cloud API (Graph API). Solo lo que el sistema necesita. */

export type SendFailureKind =
  | "auth" // token vencido o revocado: reconectar el canal
  | "window" // fuera de la ventana de 24 h: solo plantillas
  | "recipient" // numero invalido, no esta en WhatsApp o no autorizado (numero de prueba)
  | "rate" // limite de velocidad: reintentar con espera
  | "server" // falla de Meta o de red: reintentar
  | "other";

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly details: { status?: number; code?: number; subcode?: number; kind: SendFailureKind },
  ) {
    super(message);
    this.name = "WhatsAppApiError";
  }
  get kind(): SendFailureKind {
    return this.details.kind;
  }
  get code(): number | undefined {
    return this.details.code;
  }
  /** Vale la pena reintentar el mismo mensaje mas tarde. */
  get retryable(): boolean {
    return this.details.kind === "rate" || this.details.kind === "server";
  }
}

/** Traduce el error de la Graph API a una categoria accionable. */
export function classifyGraphError(status: number | undefined, code: number | undefined): SendFailureKind {
  if (status === 401 || code === 190 || code === 102) return "auth";
  if (code === 131047 || code === 131051) return "window";
  if (code === 131026 || code === 131030 || code === 131021 || code === 1013) return "recipient";
  if (code === 130429 || code === 80007 || code === 4 || code === 17 || code === 32 || code === 613 || status === 429) {
    return "rate";
  }
  if (status === undefined || status >= 500 || code === 131000 || code === 2) return "server";
  return "other";
}

export interface WhatsAppClientOptions {
  accessToken: string;
  phoneNumberId: string;
  apiVersion?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class WhatsAppClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: WhatsAppClientOptions) {
    if (!options.accessToken) throw new Error("Falta el token de acceso de WhatsApp");
    if (!options.phoneNumberId) throw new Error("Falta el phone_number_id");
    this.base = `${(options.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "")}/${options.apiVersion ?? "v23.0"}`;
    this.doFetch = options.fetch ?? fetch;
  }

  /** Envia texto. `to` = wa_id (solo digitos). Devuelve el wamid asignado por Meta. */
  async sendText(to: string, body: string): Promise<{ wamid: string }> {
    return this.send({ to, type: "text", text: { body, preview_url: false } });
  }

  async sendLocation(
    to: string,
    location: { latitude: number; longitude: number; name?: string; address?: string },
  ): Promise<{ wamid: string }> {
    return this.send({ to, type: "location", location });
  }

  /** Marca el mensaje como leido (palomitas azules). Mejor esfuerzo: no lanza. */
  async markRead(wamid: string): Promise<void> {
    try {
      await this.post({ status: "read", message_id: wamid });
    } catch {
      /* no es critico */
    }
  }

  private async send(payload: Record<string, unknown>): Promise<{ wamid: string }> {
    const json = (await this.post({ recipient_type: "individual", ...payload })) as {
      messages?: Array<{ id?: string }>;
    };
    const wamid = json.messages?.[0]?.id;
    if (!wamid) {
      throw new WhatsAppApiError("Meta acepto la peticion pero no devolvio el id del mensaje", { kind: "server" });
    }
    return { wamid };
  }

  private async post(body: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.base}/${this.options.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (e) {
      // Nunca se incluye el token ni las cabeceras en el mensaje.
      throw new WhatsAppApiError(`Fallo de red con WhatsApp (${e instanceof Error ? e.name : "error"})`, {
        kind: "server",
      });
    }

    const raw = await response.text();
    let json: { error?: { message?: string; code?: number; error_subcode?: number } } = {};
    try {
      json = JSON.parse(raw);
    } catch {
      /* respuesta no JSON */
    }
    if (!response.ok || json.error) {
      const code = json.error?.code;
      throw new WhatsAppApiError(
        `WhatsApp rechazo el envio (HTTP ${response.status}${code ? `, codigo ${code}` : ""}): ${json.error?.message ?? "sin detalle"}`,
        {
          status: response.status,
          code,
          subcode: json.error?.error_subcode,
          kind: classifyGraphError(response.status, code),
        },
      );
    }
    return json;
  }
}
