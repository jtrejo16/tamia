import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------- Helpers compartidos ----------

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const pk = () => uuid("id").primaryKey().defaultRandom();

export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

// ---------- Enums ----------

export const roleEnum = pgEnum("role", ["owner", "agent", "viewer"]);
export const planEnum = pgEnum("plan", ["esencial", "profesional", "premium"]);
/** pending = se registro solo y espera aprobacion del operador. */
export const tenantStatusEnum = pgEnum("tenant_status", ["active", "paused", "cancelled", "pending"]);
export const subscriptionStatusEnum = pgEnum("subscription_status", ["trialing", "active", "past_due", "canceled", "comped"]);

// ---------- Tablas ----------

/** Datos del negocio que el agente usa como "datos fijos" y politicas. Todo opcional. */
export interface TenantProfile {
  description?: string;
  address?: string;
  mapsUrl?: string;
  latitude?: number;
  longitude?: number;
  paymentMethods?: string[];
  /** Datos clave cortos que siempre deben estar a la mano (estacionamiento, accesibilidad...). */
  keyFacts?: string[];
  cancellationPolicy?: string;
  /** Horas minimas de aviso para cancelar/reprogramar sin pasar por un humano. */
  cancellationNoticeHours?: number;
  depositPolicy?: string;
}

/** El negocio cliente. No lleva tenant_id: su propio id es el tenant. */
export const tenants = pgTable("tenants", {
  id: pk(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  vertical: text("vertical").notNull(), // dental | seguros | ...
  timezone: text("timezone").notNull().default("America/Merida"),
  locale: text("locale").notNull().default("es-MX"),
  plan: planEnum("plan").notNull().default("esencial"),
  status: tenantStatusEnum("status").notNull().default("active"),
  privacyNoticeUrl: text("privacy_notice_url"),
  profile: jsonb("profile").$type<TenantProfile>().notNull().default({}),
  /** Horario de atencion humana: { "mon": ["09:00","19:00"], ... } */
  humanHours: jsonb("human_hours").$type<Record<string, [string, string] | null>>(),
  ...timestamps,
});

/** Columna tenant_id estandar: toda tabla de negocio la usa. */
export const tenantRef = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });

/** Usuarios del panel. Globales: un usuario puede pertenecer a varios negocios. */
export const users = pgTable("users", {
  id: pk(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash"),
  /**
   * Version de las sesiones: subirla cierra TODAS las sesiones abiertas del usuario (cada
   * cookie lleva la version con la que se emitio y se compara en cada peticion).
   */
  sessionVersion: integer("session_version").notNull().default(0),
  /** Contrasena temporal: el usuario debe cambiarla antes de hacer nada mas. */
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  /** Operador de la plataforma (el dueno del SaaS): ve y administra todos los negocios. */
  isOperator: boolean("is_operator").notNull().default(false),
  ...timestamps,
});

/**
 * Suscripcion de un negocio. La app SOLO puede leerla; se modifica unicamente con las funciones
 * SECURITY DEFINER (alta, cobro, operador), para que ningun dueno pueda darse un plan a si mismo.
 */
export const subscriptions = pgTable("subscriptions", {
  id: pk(),
  tenantId: tenantRef().unique(),
  status: subscriptionStatusEnum("status").notNull().default("trialing"),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  /** Proximo cobro (o fin del periodo pagado) segun Mercado Pago. */
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  /** Plan elegido en un checkout aun no autorizado. */
  pendingPlan: planEnum("pending_plan"),
  mpPreapprovalId: text("mp_preapproval_id"),
  mpPayerEmail: text("mp_payer_email"),
  /** El cliente ya autorizo su tarjeta en Mercado Pago (cobrara al terminar la prueba). */
  cardAuthorized: boolean("card_authorized").notNull().default(false),
  ...timestamps,
});

export const memberships = pgTable(
  "memberships",
  {
    id: pk(),
    tenantId: tenantRef(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull().default("viewer"),
    ...timestamps,
  },
  (t) => [uniqueIndex("memberships_tenant_user_uq").on(t.tenantId, t.userId)],
);

/** Bitacora append-only: el rol de la app no puede UPDATE ni DELETE. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: pk(),
    tenantId: tenantRef(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    diff: jsonb("diff"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_tenant_created_idx").on(t.tenantId, t.createdAt)],
);
