import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Cliente minimo de Mercado Pago para suscripciones (API "preapproval").
 * Docs: https://www.mercadopago.com.mx/developers/es/reference/subscriptions
 *
 * Nunca guarda ni ve datos de tarjeta: el cliente los captura en la pagina de Mercado Pago.
 */
export interface MercadoPagoOptions {
  accessToken: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface Preapproval {
  id: string;
  status: string; // pending | authorized | paused | cancelled
  initPoint: string | null;
  nextPaymentDate: Date | null;
  externalReference: string | null;
}

export class MercadoPagoError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MercadoPagoError";
  }
}

/** Reconoce el error por nombre (no por clase): sigue funcionando si el modulo se recarga en caliente. */
export const isMercadoPagoError = (e: unknown): e is MercadoPagoError => e instanceof Error && e.name === "MercadoPagoError";

interface RawPreapproval {
  id?: string;
  status?: string;
  init_point?: string;
  next_payment_date?: string;
  external_reference?: string;
  message?: string;
}

const toPreapproval = (r: RawPreapproval): Preapproval => ({
  id: String(r.id ?? ""),
  status: r.status ?? "pending",
  initPoint: r.init_point ?? null,
  nextPaymentDate: r.next_payment_date ? new Date(r.next_payment_date) : null,
  externalReference: r.external_reference ?? null,
});

export class MercadoPagoClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: MercadoPagoOptions) {
    this.base = (options.baseUrl ?? "https://api.mercadopago.com").replace(/\/$/, "");
    this.doFetch = options.fetch ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) throw new MercadoPagoError(json.message ?? `Mercado Pago respondio ${res.status}`, res.status);
    return json;
  }

  /** Crea una suscripcion pendiente: devuelve el enlace (init_point) donde el cliente captura su tarjeta. */
  async createSubscription(input: {
    reason: string;
    amountMxn: number;
    payerEmail: string;
    /** Identifica a nuestro negocio en los avisos de MP. */
    externalReference: string;
    backUrl: string;
    /** Primer cobro (fin de la prueba gratis). Si es null se cobra al autorizar. */
    startDate: Date | null;
  }): Promise<Preapproval> {
    const recurring: Record<string, unknown> = {
      frequency: 1,
      frequency_type: "months",
      transaction_amount: input.amountMxn,
      currency_id: "MXN",
    };
    if (input.startDate && input.startDate.getTime() > Date.now() + 3_600_000) {
      recurring.start_date = input.startDate.toISOString();
    }
    return toPreapproval(
      await this.call<RawPreapproval>("POST", "/preapproval", {
        reason: input.reason,
        external_reference: input.externalReference,
        payer_email: input.payerEmail,
        back_url: input.backUrl,
        auto_recurring: recurring,
        status: "pending",
      }),
    );
  }

  async getSubscription(id: string): Promise<Preapproval> {
    return toPreapproval(await this.call<RawPreapproval>("GET", `/preapproval/${encodeURIComponent(id)}`));
  }

  async cancelSubscription(id: string): Promise<Preapproval> {
    return toPreapproval(await this.call<RawPreapproval>("PUT", `/preapproval/${encodeURIComponent(id)}`, { status: "cancelled" }));
  }

  /** Un cobro de la suscripcion: dice a que suscripcion pertenece. */
  async getAuthorizedPayment(id: string): Promise<{ preapprovalId: string | null }> {
    const r = await this.call<{ preapproval_id?: string | number }>("GET", `/authorized_payments/${encodeURIComponent(id)}`);
    return { preapprovalId: r.preapproval_id != null ? String(r.preapproval_id) : null };
  }
}

/**
 * Verifica la firma de un aviso (webhook) de Mercado Pago.
 * Cabecera x-signature = "ts=...,v1=<hmac>"; el HMAC-SHA256 (hex, con el secreto del webhook) es de
 * `id:<data.id en minusculas>;request-id:<x-request-id>;ts:<ts>;`. Tolerancia de reloj: 10 minutos
 * para que un aviso capturado no se pueda repetir mas tarde.
 */
export function verifyMercadoPagoSignature(input: {
  secret: string;
  signatureHeader: string | null;
  requestId: string | null;
  dataId: string | null;
  now?: number;
}): boolean {
  const { secret, signatureHeader, requestId, dataId } = input;
  if (!secret || !signatureHeader || !requestId || !dataId) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1 || !/^\d+$/.test(ts)) return false;

  const tsMs = ts.length <= 10 ? Number(ts) * 1000 : Number(ts); // segundos o milisegundos
  if (Math.abs((input.now ?? Date.now()) - tsMs) > 10 * 60_000) return false;

  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const expected = createHmac("sha256", secret).update(manifest).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
