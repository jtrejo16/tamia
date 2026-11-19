import {
  boolean,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, pk, tenantRef, timestamps } from "./core";
import { jsonb } from "drizzle-orm/pg-core";
import { contacts, conversations } from "./channels";

export const appointmentStatusEnum = pgEnum("appointment_status", [
  "pending",
  "confirmed",
  "cancelled",
  "no_show",
  "done",
]);

export const services = pgTable("services", {
  id: pk(),
  tenantId: tenantRef(),
  name: text("name").notNull(),
  description: text("description"),
  durationMin: integer("duration_min").notNull(),
  bufferMin: integer("buffer_min").notNull().default(0),
  /** Centavos, para evitar errores de redondeo. */
  priceCents: integer("price_cents"),
  currency: text("currency").notNull().default("MXN"),
  requiresDeposit: boolean("requires_deposit").notNull().default(false),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export const staff = pgTable("staff", {
  id: pk(),
  tenantId: tenantRef(),
  name: text("name").notNull(),
  roleLabel: text("role_label"),
  calendarProvider: text("calendar_provider"), // google | cal_com
  calendarId: text("calendar_id"),
  credentialsEnc: bytea("credentials_enc"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export const staffServices = pgTable(
  "staff_services",
  {
    id: pk(),
    tenantId: tenantRef(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("staff_services_uq").on(t.staffId, t.serviceId)],
);

/** staff_id nulo = horario general del negocio. weekday: 0=domingo ... 6=sabado. */
export const businessHours = pgTable("business_hours", {
  id: pk(),
  tenantId: tenantRef(),
  staffId: uuid("staff_id").references(() => staff.id, { onDelete: "cascade" }),
  weekday: smallint("weekday").notNull(),
  opens: time("opens").notNull(),
  closes: time("closes").notNull(),
});

export const businessHolidays = pgTable("business_holidays", {
  id: pk(),
  tenantId: tenantRef(),
  staffId: uuid("staff_id").references(() => staff.id, { onDelete: "cascade" }),
  date: date("date").notNull(),
  reason: text("reason"),
});

/**
 * El indice de exclusion que impide traslapes por empleado vive en la migracion
 * SQL personalizada (Drizzle no puede expresarlo).
 */
export const appointments = pgTable(
  "appointments",
  {
    id: pk(),
    tenantId: tenantRef(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: appointmentStatusEnum("status").notNull().default("pending"),
    calendarEventId: text("calendar_event_id"),
    /** Ultima vez que esta cita se reflejo en el calendario externo (Google). Si es anterior a updated_at, hay que sincronizarla. */
    calendarSyncedAt: timestamp("calendar_synced_at", { withTimezone: true }),
    /** Cuando se le pidio al cliente su resena por esta cita (una sola vez por cita). */
    reviewRequestedAt: timestamp("review_requested_at", { withTimezone: true }),
    reminder24hSentAt: timestamp("reminder_24h_sent_at", { withTimezone: true }),
    reminder2hSentAt: timestamp("reminder_2h_sent_at", { withTimezone: true }),
    confirmedByContact: boolean("confirmed_by_contact").notNull().default(false),
    sourceConversationId: uuid("source_conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    index("appointments_tenant_starts_idx").on(t.tenantId, t.startsAt),
    index("appointments_contact_idx").on(t.contactId),
  ],
);

/**
 * Calendario externo de un negocio (por ahora solo Google Calendar). Las citas confirmadas se reflejan como
 * eventos en ese calendario. El token de renovacion va CIFRADO (AES-256-GCM, ligado al negocio).
 */
export const calendarConnections = pgTable("calendar_connections", {
  id: pk(),
  tenantId: tenantRef().unique(),
  provider: text("provider").notNull().default("google"),
  /** Cuenta de Google que autorizo (para mostrarla en Ajustes). */
  accountEmail: text("account_email"),
  calendarId: text("calendar_id").notNull().default("primary"),
  refreshTokenEnc: bytea("refresh_token_enc").notNull(),
  /** active | error (Google revoco el permiso o fallo la renovacion: hay que reconectar). */
  status: text("status").notNull().default("active"),
  lastError: text("last_error"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  ...timestamps,
});

/** Destinatario de los avisos del negocio: un numero de WhatsApp o un correo. */
export interface NotificationRecipient {
  id: string;
  kind: "whatsapp" | "email";
  /** "+521999..." (WhatsApp) o correo. */
  address: string;
  enabled: boolean;
}

/**
 * Avisos al equipo cuando una conversacion necesita a una persona (la pide el cliente, urgencia o queja).
 * mode: "business_hours" = solo en horario de atencion humana; "always" = a cualquier hora.
 */
export const notificationSettings = pgTable("notification_settings", {
  id: pk(),
  tenantId: tenantRef().unique(),
  enabled: boolean("enabled").notNull().default(false),
  mode: text("mode").notNull().default("business_hours"),
  recipients: jsonb("recipients").$type<NotificationRecipient[]>().notNull().default([]),
  ...timestamps,
});

/** Solicitud de resena despues de la cita (por WhatsApp). platform: google | facebook | other. */
export const reviewSettings = pgTable("review_settings", {
  id: pk(),
  tenantId: tenantRef().unique(),
  enabled: boolean("enabled").notNull().default(false),
  hoursAfter: integer("hours_after").notNull().default(3),
  platform: text("platform").notNull().default("google"),
  url: text("url"),
  /** Desde cuando esta activa: solo se pide resena de citas que terminan DESPUES (no de las ya pasadas). */
  enabledAt: timestamp("enabled_at", { withTimezone: true }),
  ...timestamps,
});
