import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { pk, tenantRef, timestamps, users } from "./core";
import { conversations } from "./channels";

/** Dimension del modelo de embeddings fijo de la plataforma. Cambiarla exige re-vectorizar todo. */
export const EMBEDDING_DIMENSIONS = 1536;

export const knowledgeStatusEnum = pgEnum("knowledge_status", [
  "pending",
  "indexing",
  "ready",
  "failed",
]);
export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "edited",
  "discarded",
]);
export const usageKindEnum = pgEnum("usage_kind", [
  "llm",
  "embedding",
  "transcription",
  "whatsapp",
]);

export const knowledgeDocs = pgTable("knowledge_docs", {
  id: pk(),
  tenantId: tenantRef(),
  title: text("title").notNull(),
  sourceType: text("source_type").notNull(), // pdf | docx | txt | text
  fileUrl: text("file_url"),
  rawText: text("raw_text"),
  status: knowledgeStatusEnum("status").notNull().default("pending"),
  ...timestamps,
});

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: pk(),
    tenantId: tenantRef(),
    docId: uuid("doc_id")
      .notNull()
      .references(() => knowledgeDocs.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("knowledge_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("knowledge_chunks_doc_idx").on(t.docId),
  ],
);

/** Borradores del modo entrenamiento. El par draft -> final alimenta los few-shot. */
export const approvals = pgTable(
  "approvals",
  {
    id: pk(),
    tenantId: tenantRef(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    draft: text("draft").notNull(),
    finalText: text("final_text"),
    status: approvalStatusEnum("status").notNull().default("pending"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("approvals_tenant_status_idx").on(t.tenantId, t.status)],
);

export const handoffs = pgTable("handoffs", {
  id: pk(),
  tenantId: tenantRef(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  urgency: text("urgency").notNull().default("normal"), // normal | alta
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  takenBy: uuid("taken_by").references(() => users.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  ...timestamps,
});

export const usageEvents = pgTable(
  "usage_events",
  {
    id: pk(),
    tenantId: tenantRef(),
    kind: usageKindEnum("kind").notNull(),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    /** Millonesimas de dolar, para sumar sin perder precision. */
    costUsdMicros: integer("cost_usd_micros").notNull().default(0),
    refMessageId: uuid("ref_message_id"),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("usage_events_tenant_created_idx").on(t.tenantId, t.createdAt)],
);
