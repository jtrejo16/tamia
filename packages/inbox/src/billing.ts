import {
  auditLog,
  billingApplyPreapproval,
  billingAttachPreapproval,
  signupCreateTenant,
  subscriptions,
  tenants,
  withTenant,
  type Database,
} from "@empleado/db";
import { MODEL_TIERS } from "@empleado/llm";
import {
  PLANS,
  TRIAL_DAYS,
  accessFor,
  assertPasswordStrength,
  hashPassword,
  isPlanId,
  type AccessReason,
  type PlanId,
  type SubscriptionFacts,
  type SubscriptionStatus,
  type TenantStatus,
} from "@empleado/shared";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { isMercadoPagoError, type MercadoPagoClient } from "./mercadopago";
import { can, fail, type Failure, type PanelContext, type Success } from "./types";

// ----------------------------------------------------------------- alta (registro publico)

export const VERTICALS = [{ id: "dental", label: "Clínica dental" }] as const;

const signupSchema = z.object({
  businessName: z.string().trim().min(2, "Escribe el nombre del negocio").max(80),
  vertical: z.enum(["dental"]),
  timezone: z.string().trim().min(3).max(60).default("America/Merida"),
  ownerName: z.string().trim().min(2, "Escribe tu nombre").max(80),
  email: z.string().trim().toLowerCase().email("Correo inválido").max(120),
  password: z.string().max(200),
});

const slugify = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "negocio";

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("es-MX", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type SignupResult =
  | Success<{ tenantId: string; userId: string; sessionVersion: number }>
  | Failure<"invalid" | "email_taken" | "weak_password">
  | (Failure<"invalid"> & { details: string[] });

/**
 * Registro publico: crea el negocio en estado PENDIENTE (hasta que el operador lo apruebe),
 * su dueno y la prueba gratis. Si el correo ya tiene cuenta, se rechaza sin tocarla.
 */
export async function signup(db: Database, raw: unknown): Promise<SignupResult> {
  const parsed = signupSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "invalid", details: parsed.error.issues.map((i) => i.message) };
  }
  const input = parsed.data;
  if (!validTimezone(input.timezone)) return { ok: false, error: "invalid", details: ["Zona horaria inválida"] };

  let hash: string;
  try {
    assertPasswordStrength(input.password);
    hash = await hashPassword(input.password);
  } catch {
    return fail("weak_password");
  }

  const tier = MODEL_TIERS.economico;
  // El identificador publico lleva un sufijo al azar: evita choques y que se pueda adivinar.
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = `${slugify(input.businessName)}-${randomBytes(3).toString("hex")}`;
    const res = await signupCreateTenant(db, {
      name: input.businessName,
      slug,
      vertical: input.vertical,
      timezone: input.timezone,
      email: input.email,
      userName: input.ownerName,
      passwordHash: hash,
      model: tier.model,
      fallbackModel: tier.fallback,
      trialDays: TRIAL_DAYS,
    });
    if (res.ok) return { ok: true, tenantId: res.tenantId, userId: res.userId, sessionVersion: 0 };
    if (res.error === "email_taken") return fail("email_taken");
  }
  throw new Error("No se pudo generar un identificador unico para el negocio");
}

// ----------------------------------------------------------------- estado de facturacion

export interface BillingView {
  tenantStatus: TenantStatus;
  plan: PlanId;
  subscription: {
    status: SubscriptionStatus;
    trialEndsAt: Date | null;
    currentPeriodEnd: Date | null;
    cardAuthorized: boolean;
    pendingPlan: PlanId | null;
    hasCheckout: boolean;
  } | null;
  access: { allowed: boolean; reason: AccessReason };
  /** Solo si el dueño puede cobrar: Mercado Pago esta configurado en el servidor. */
  paymentsEnabled: boolean;
}

const scope = (ctx: PanelContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

export function subscriptionFacts(row: typeof subscriptions.$inferSelect): SubscriptionFacts {
  return {
    status: row.status,
    trialEndsAt: row.trialEndsAt,
    currentPeriodEnd: row.currentPeriodEnd,
    cardAuthorized: row.cardAuthorized,
  };
}

export async function getBilling(db: Database, ctx: PanelContext, paymentsEnabled: boolean): Promise<BillingView> {
  return withTenant(db, scope(ctx), async (tx) => {
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
    const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.tenantId, ctx.tenantId));
    if (!tenant) throw new Error("tenant inexistente");
    return {
      tenantStatus: tenant.status,
      plan: tenant.plan,
      subscription: sub
        ? {
            status: sub.status,
            trialEndsAt: sub.trialEndsAt,
            currentPeriodEnd: sub.currentPeriodEnd,
            cardAuthorized: sub.cardAuthorized,
            pendingPlan: sub.pendingPlan,
            hasCheckout: sub.mpPreapprovalId !== null,
          }
        : null,
      access: accessFor(tenant.status, sub ? subscriptionFacts(sub) : null),
      paymentsEnabled,
    };
  });
}

/** Lo usa el worker: ¿este negocio puede recibir respuestas del asistente y recordatorios ahora? */
export async function tenantAccess(db: Database, tenantId: string): Promise<{ allowed: boolean; reason: AccessReason }> {
  return withTenant(db, { tenantId }, async (tx) => {
    const [tenant] = await tx.select({ status: tenants.status }).from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) return { allowed: false, reason: "tenant_inactive" as const };
    const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId));
    return accessFor(tenant.status, sub ? subscriptionFacts(sub) : null);
  });
}

// ----------------------------------------------------------------- checkout y cancelacion

export type BillingError = "forbidden" | "invalid_plan" | "no_subscription" | "payments_unavailable" | "provider_error" | "comped" | "no_checkout";

/** Crea la suscripcion en Mercado Pago y devuelve el enlace donde el cliente captura su tarjeta. */
export async function startCheckout(
  db: Database,
  ctx: PanelContext,
  mp: MercadoPagoClient | null,
  input: { plan: unknown; payerEmail: string; backUrl: string },
): Promise<Success<{ url: string }> | Failure<BillingError>> {
  if (!can(ctx.role, "billing")) return fail("forbidden");
  if (!isPlanId(input.plan)) return fail("invalid_plan");
  if (!mp) return fail("payments_unavailable");
  const plan = PLANS[input.plan];

  const [sub] = await withTenant(db, scope(ctx), (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.tenantId, ctx.tenantId)),
  );
  if (!sub) return fail("no_subscription");
  if (sub.status === "comped") return fail("comped");

  try {
    // Si queda prueba gratis, el primer cobro es al terminarla.
    const preapproval = await mp.createSubscription({
      reason: `Empleado Digital — plan ${plan.name}`,
      amountMxn: plan.priceMxn,
      payerEmail: input.payerEmail,
      externalReference: ctx.tenantId,
      backUrl: input.backUrl,
      startDate: sub.status === "trialing" ? sub.trialEndsAt : null,
    });
    if (!preapproval.initPoint) return fail("provider_error");
    await billingAttachPreapproval(db, scope(ctx), {
      preapprovalId: preapproval.id,
      plan: plan.id,
      payerEmail: input.payerEmail,
    });
    await withTenant(db, scope(ctx), (tx) =>
      tx.insert(auditLog).values({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: "billing.checkout_started",
        entity: "subscription",
        entityId: preapproval.id,
        diff: { plan: plan.id } as never,
      }),
    );
    return { ok: true, url: preapproval.initPoint };
  } catch (error) {
    if (isMercadoPagoError(error)) return fail("provider_error");
    throw error;
  }
}

/** Cancela la renovacion. Se conserva el acceso hasta donde ya estaba pagado/de prueba (ver accessFor). */
export async function cancelSubscription(
  db: Database,
  ctx: PanelContext,
  mp: MercadoPagoClient | null,
): Promise<Success | Failure<BillingError>> {
  if (!can(ctx.role, "billing")) return fail("forbidden");
  if (!mp) return fail("payments_unavailable");
  const [sub] = await withTenant(db, scope(ctx), (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.tenantId, ctx.tenantId)),
  );
  if (!sub?.mpPreapprovalId) return fail("no_checkout");
  try {
    const result = await mp.cancelSubscription(sub.mpPreapprovalId);
    await billingApplyPreapproval(db, { preapprovalId: sub.mpPreapprovalId, mpStatus: result.status, nextPayment: result.nextPaymentDate });
    await withTenant(db, scope(ctx), (tx) =>
      tx.insert(auditLog).values({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: "billing.cancelled",
        entity: "subscription",
        entityId: sub.mpPreapprovalId,
      }),
    );
    return { ok: true };
  } catch (error) {
    if (isMercadoPagoError(error)) return fail("provider_error");
    throw error;
  }
}

/** Al volver de Mercado Pago (o con el boton "actualizar"): consulta el estado real y lo aplica. */
export async function refreshFromProvider(db: Database, ctx: PanelContext, mp: MercadoPagoClient | null): Promise<Success | Failure<BillingError>> {
  if (!can(ctx.role, "billing")) return fail("forbidden");
  if (!mp) return fail("payments_unavailable");
  const [sub] = await withTenant(db, scope(ctx), (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.tenantId, ctx.tenantId)),
  );
  if (!sub?.mpPreapprovalId) return fail("no_checkout");
  try {
    const current = await mp.getSubscription(sub.mpPreapprovalId);
    await billingApplyPreapproval(db, { preapprovalId: sub.mpPreapprovalId, mpStatus: current.status, nextPayment: current.nextPaymentDate });
    return { ok: true };
  } catch (error) {
    if (isMercadoPagoError(error)) return fail("provider_error");
    throw error;
  }
}

// ----------------------------------------------------------------- avisos (webhook) de Mercado Pago

/**
 * El aviso solo dice "algo paso con X": el estado real se consulta a la API de Mercado Pago con
 * nuestro token (nunca se confia en el contenido del aviso). Devuelve si se aplico algo.
 */
export async function handleMercadoPagoEvent(
  db: Database,
  mp: MercadoPagoClient,
  event: { type: string; dataId: string },
): Promise<{ applied: boolean }> {
  try {
    let preapprovalId: string | null = null;
    if (event.type === "subscription_preapproval" || event.type === "preapproval") {
      preapprovalId = event.dataId;
    } else if (event.type === "subscription_authorized_payment" || event.type === "authorized_payment") {
      preapprovalId = (await mp.getAuthorizedPayment(event.dataId)).preapprovalId;
    }
    if (!preapprovalId) return { applied: false };

    const current = await mp.getSubscription(preapprovalId);
    const tenantId = await billingApplyPreapproval(db, {
      preapprovalId,
      mpStatus: current.status,
      nextPayment: current.nextPaymentDate,
    });
    return { applied: tenantId !== null };
  } catch (error) {
    // Un id que Mercado Pago no conoce (por ejemplo, el aviso de "Simular", o de otra aplicacion) no es un
    // fallo nuestro: se responde bien para que no lo reintente. Las fallas reales (5xx, red) si se propagan.
    if (isMercadoPagoError(error) && (error.status === 404 || error.status === 400)) return { applied: false };
    throw error;
  }
}
