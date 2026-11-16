/**
 * Planes y regla de acceso al servicio. Los precios son un punto de partida: se ajustan aqui
 * (un solo lugar) y el cobro usa lo que diga este archivo.
 */
export type PlanId = "esencial" | "profesional" | "premium";

export interface PlanInfo {
  id: PlanId;
  name: string;
  /** Precio mensual en pesos mexicanos (IVA incluido). */
  priceMxn: number;
  tagline: string;
  features: string[];
}

export const TRIAL_DAYS = 14;

export const PLANS: Record<PlanId, PlanInfo> = {
  esencial: {
    id: "esencial",
    name: "Esencial",
    priceMxn: 799,
    tagline: "Para empezar a atender por WhatsApp",
    features: ["Asistente con IA económica", "Agenda y recordatorios de cita", "Bandeja y aprobaciones", "1 número de WhatsApp"],
  },
  profesional: {
    id: "profesional",
    name: "Profesional",
    priceMxn: 1499,
    tagline: "El que elige la mayoría de las clínicas",
    features: ["Todo lo de Esencial", "IA balanceada (mejor redacción)", "Usuarios del equipo", "Soporte prioritario"],
  },
  premium: {
    id: "premium",
    name: "Premium",
    priceMxn: 2999,
    tagline: "Máxima calidad y acompañamiento",
    features: ["Todo lo de Profesional", "IA premium", "Configuración asistida", "Soporte directo"],
  },
};

export const PLAN_IDS = Object.keys(PLANS) as PlanId[];
export const isPlanId = (v: unknown): v is PlanId => typeof v === "string" && v in PLANS;

/** Hasta cuando llega el acceso de una suscripcion cancelada (lo ya pagado o la prueba), o null. */
export function accessEndsAt(sub: SubscriptionFacts): Date | null {
  const ends = [sub.currentPeriodEnd, sub.trialEndsAt].filter((d): d is Date => d !== null);
  return ends.length > 0 ? new Date(Math.max(...ends.map((d) => d.getTime()))) : null;
}

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "comped";
export type TenantStatus = "active" | "paused" | "cancelled" | "pending";

export interface SubscriptionFacts {
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  cardAuthorized: boolean;
}

/** Dias de gracia: tolerancia para que un cobro retrasado no corte el servicio de golpe. */
export const GRACE_DAYS = 3;
const DAY = 86_400_000;

export type AccessReason =
  | "ok"
  | "tenant_pending"
  | "tenant_inactive"
  | "no_subscription"
  | "trial_ended"
  | "payment_overdue"
  | "canceled";

/**
 * Regla unica: el asistente responde y manda recordatorios solo si el negocio esta aprobado
 * (active) Y su suscripcion esta vigente. La usan el worker y el panel (mismo resultado en ambos).
 */
export function accessFor(
  tenantStatus: TenantStatus,
  sub: SubscriptionFacts | null,
  now = new Date(),
): { allowed: boolean; reason: AccessReason } {
  if (tenantStatus === "pending") return { allowed: false, reason: "tenant_pending" };
  if (tenantStatus !== "active") return { allowed: false, reason: "tenant_inactive" };
  if (!sub) return { allowed: false, reason: "no_subscription" };

  const t = now.getTime();
  const within = (end: Date | null, graceDays: number) => end !== null && end.getTime() + graceDays * DAY > t;

  switch (sub.status) {
    case "comped":
      return { allowed: true, reason: "ok" };
    case "trialing":
      // Con tarjeta ya autorizada el cobro ocurre al terminar la prueba: se da gracia a que llegue.
      return within(sub.trialEndsAt, sub.cardAuthorized ? GRACE_DAYS : 0)
        ? { allowed: true, reason: "ok" }
        : { allowed: false, reason: "trial_ended" };
    case "active":
      // Si MP no ha avisado del siguiente periodo, se confia en el estado; si lo hay, con gracia.
      return sub.currentPeriodEnd === null || within(sub.currentPeriodEnd, GRACE_DAYS)
        ? { allowed: true, reason: "ok" }
        : { allowed: false, reason: "payment_overdue" };
    case "past_due":
      return within(sub.currentPeriodEnd, GRACE_DAYS)
        ? { allowed: true, reason: "ok" }
        : { allowed: false, reason: "payment_overdue" };
    case "canceled": {
      // Cancelar detiene la RENOVACION, no el periodo ya pagado ni la prueba en curso: se conserva el acceso hasta ahi.
      const ends = [sub.currentPeriodEnd, sub.trialEndsAt].filter((d): d is Date => d !== null).map((d) => d.getTime());
      return ends.length > 0 && Math.max(...ends) > t ? { allowed: true, reason: "ok" } : { allowed: false, reason: "canceled" };
    }
  }
}
