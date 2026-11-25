import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  index,
} from "drizzle-orm/pg-core";
import { bytea, pk, tenantRef, timestamps } from "./core";
import { users } from "./core";

export const autonomyEnum = pgEnum("autonomy", ["copilot", "semi", "auto"]);
export const channelStatusEnum = pgEnum("channel_status", ["active", "paused", "error"]);
export const templateCategoryEnum = pgEnum("template_category", [
  "utility",
  "marketing",
  "authentication",
]);
export const conversationStateEnum = pgEnum("conversation_state", ["bot", "human", "closed"]);
export const directionEnum = pgEnum("direction", ["in", "out"]);
export const senderEnum = pgEnum("sender", ["contact", "bot", "human"]);
export const messageTypeEnum = pgEnum("message_type", [
  "text",
  "audio",
  "image",
  "location",
  "template",
  "interactive",
  "document",
]);
export const messageStatusEnum = pgEnum("message_status", [
  "received",
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
]);

/** Un canal conectado (WhatsApp, etc.). external_id = phone_number_id en WhatsApp. */
export const channels = pgTable(
  "channels",
  {
    id: pk(),
    tenantId: tenantRef(),
    type: text("type").notNull(), // whatsapp | instagram | ...
    /** Identificador que mapea webhook -> tenant. Unico global por tipo. */
    externalId: text("external_id").notNull(),
    wabaId: text("waba_id"),
    displayPhone: text("display_phone"),
    /** Token cifrado con AES-256-GCM (packages/shared). */
    credentialsEnc: bytea("credentials_enc"),
    status: channelStatusEnum("status").notNull().default("active"),
    qualityRating: text("quality_rating"),
    meta: jsonb("meta"),
    ...timestamps,
  },
  (t) => [uniqueIndex("channels_type_external_uq").on(t.type, t.externalId)],
);

export const agentConfigs = pgTable("agent_configs", {
  id: pk(),
  tenantId: tenantRef().unique(),
  assistantName: text("assistant_name").notNull().default("Asistente"),
  tone: text("tone").notNull().default("cálido y profesional"),
  formality: text("formality").notNull().default("usted"), // tu | usted
  model: text("model").notNull(),
  fallbackModel: text("fallback_model"),
  temperature: real("temperature").notNull().default(0.3),
  autonomy: autonomyEnum("autonomy").notNull().default("copilot"),
  escalationRules: jsonb("escalation_rules").$type<string[]>().notNull().default([]),
  forbiddenTopics: jsonb("forbidden_topics").$type<string[]>().notNull().default([]),
  packSlug: text("pack_slug"),
  packVersion: text("pack_version"),
  ...timestamps,
});

export const templates = pgTable(
  "templates",
  {
    id: pk(),
    tenantId: tenantRef(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    language: text("language").notNull().default("es_MX"),
    category: templateCategoryEnum("category").notNull(),
    components: jsonb("components").notNull(),
    status: text("status").notNull().default("draft"), // draft | pending | approved | rejected
    metaTemplateId: text("meta_template_id"),
    ...timestamps,
  },
  (t) => [uniqueIndex("templates_channel_name_lang_uq").on(t.channelId, t.name, t.language)],
);

export const contacts = pgTable(
  "contacts",
  {
    id: pk(),
    tenantId: tenantRef(),
    displayName: text("display_name"),
    phoneE164: text("phone_e164"),
    email: text("email"),
    tags: text("tags").array().notNull().default([]),
    /** Hechos durables: preferencias, seguro, idioma, etc. */
    profile: jsonb("profile").$type<Record<string, unknown>>().notNull().default({}),
    /** Notas internas del equipo sobre el cliente. NO se le dan al asistente ni al cliente. */
    notes: text("notes"),
    optInMarketing: boolean("opt_in_marketing").notNull().default(false),
    optInAt: timestamp("opt_in_at", { withTimezone: true }),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("contacts_tenant_phone_uq").on(t.tenantId, t.phoneE164)],
);

/**
 * Identidad de un cliente en un canal que NO usa telefono (Messenger: PSID, Instagram: IGSID).
 * Los clientes de WhatsApp se identifican por contacts.phone_e164 y no necesitan fila aqui.
 */
export const contactIdentities = pgTable(
  "contact_identities",
  {
    id: pk(),
    tenantId: tenantRef(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** messenger | instagram */
    channelType: text("channel_type").notNull(),
    /** PSID o IGSID: es unico POR PAGINA/CUENTA, por eso se liga tambien al canal. */
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    handle: text("handle"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("contact_identities_channel_external_uq").on(t.channelId, t.externalId),
    index("contact_identities_contact_idx").on(t.contactId),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: pk(),
    tenantId: tenantRef(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    state: conversationStateEnum("state").notNull().default("bot"),
    assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Base de la ventana de 24 h de WhatsApp. */
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    /** Estado estructurado de la tarea en curso (slot filling). */
    taskState: jsonb("task_state").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    index("conversations_tenant_last_idx").on(t.tenantId, t.lastMessageAt),
    index("conversations_contact_idx").on(t.contactId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: pk(),
    tenantId: tenantRef(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    direction: directionEnum("direction").notNull(),
    sender: senderEnum("sender").notNull(),
    type: messageTypeEnum("type").notNull().default("text"),
    body: text("body"),
    mediaUrl: text("media_url"),
    transcript: text("transcript"),
    /** wamid de Meta. Unico por canal: base de la idempotencia. */
    externalId: text("external_id"),
    status: messageStatusEnum("status").notNull().default("received"),
    error: text("error"),
    /** Categoria con la que Meta cobra este mensaje saliente y si se cobra (aviso de estado de Meta). null = aun no se sabe. */
    pricingCategory: text("pricing_category"),
    billable: boolean("billable"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("messages_channel_external_uq").on(t.channelId, t.externalId),
    index("messages_conversation_created_idx").on(t.conversationId, t.createdAt),
  ],
);

export const conversationMemory = pgTable("conversation_memory", {
  id: pk(),
  tenantId: tenantRef(),
  conversationId: uuid("conversation_id")
    .notNull()
    .unique()
    .references(() => conversations.id, { onDelete: "cascade" }),
  summary: text("summary").notNull().default(""),
  summarizedUpToMessageId: uuid("summarized_up_to_message_id"),
  ...timestamps,
});

/**
 * Asistente telefonico (voz) de un negocio. Retell hace la voz; aqui se guarda su configuracion
 * y los identificadores del agente que creamos en Retell.
 */
export const voiceSettings = pgTable("voice_settings", {
  id: pk(),
  tenantId: tenantRef().unique(),
  enabled: boolean("enabled").notNull().default(false),
  /** false = el asistente NO agenda por telefono: toma los datos y los pasa al equipo. */
  allowBooking: boolean("allow_booking").notNull().default(false),
  /** Modulo restaurante: false = por telefono solo se consulta el menu; los pedidos los toma una persona. */
  allowOrders: boolean("allow_orders").notNull().default(false),
  greeting: text("greeting"),
  voiceId: text("voice_id"),
  language: text("language").notNull().default("es-419"),
  /** Numero telefonico al que llaman los clientes (solo para mostrar; el enlace vive en Retell). */
  phoneNumber: text("phone_number"),
  /** Numero de recepcion al que se transfiere la llamada (solo en horario de atencion humana). */
  transferNumber: text("transfer_number"),
  retellLlmId: text("retell_llm_id"),
  retellAgentId: text("retell_agent_id"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  ...timestamps,
});

/** Una llamada telefonica. La transcripcion vive como mensajes de la conversacion de voz. */
export const calls = pgTable(
  "calls",
  {
    id: pk(),
    tenantId: tenantRef(),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    retellCallId: text("retell_call_id").notNull(),
    direction: text("direction").notNull().default("inbound"), // inbound | outbound
    fromNumber: text("from_number"),
    toNumber: text("to_number"),
    status: text("status").notNull().default("ongoing"), // ongoing | ended | failed
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    /** Costo real que reporta Retell, en millonesimas de dolar. null = aun no lo reporta. */
    costUsdMicros: integer("cost_usd_micros"),
    summary: text("summary"),
    sentiment: text("sentiment"),
    disconnectionReason: text("disconnection_reason"),
    /** Estado de la tarea en curso (confirmaciones pendientes), propio de ESTA llamada. */
    taskState: jsonb("task_state").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("calls_retell_call_uq").on(t.retellCallId),
    index("calls_tenant_started_idx").on(t.tenantId, t.startedAt),
  ],
);
