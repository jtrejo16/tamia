import {
  approvals,
  auditLog,
  channels,
  contacts,
  conversations,
  handoffs,
  messages,
  users,
  withTenant,
  type Database,
  type Tx,
} from "@empleado/db";
import { messageText } from "@empleado/agent";
import { isWithinServiceWindow, windowClosesAt } from "@empleado/channels";
import { and, asc, desc, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  MAX_MESSAGE_CHARS,
  can,
  fail,
  type EnqueueOutbound,
  type PanelContext,
  type Result,
} from "./types";

export type ConversationFilter = "all" | "attention" | "bot" | "human" | "closed";

export interface ContactSummary {
  id: string;
  /** Nombre real (el que dio el cliente) o, si no, el apodo de WhatsApp, o el telefono. */
  name: string;
  hasRealName: boolean;
  whatsappName: string | null;
  phone: string | null;
}

export type ChannelKind = "whatsapp" | "messenger" | "instagram" | "voice";

export interface ConversationSummary {
  id: string;
  /** Por que red escribe el cliente. */
  channel: ChannelKind;
  state: "bot" | "human" | "closed";
  assignedUserId: string | null;
  contact: ContactSummary;
  lastMessageAt: Date | null;
  lastInboundAt: Date | null;
  windowOpen: boolean;
  windowClosesAt: Date | null;
  preview: string;
  previewFromCustomer: boolean;
  pendingApprovals: number;
  /** Por que se escalo, que quiere el cliente y si fue decision del asistente o una falla tecnica (source = system). */
  handoff: { urgency: string; reason: string; summary: string | null; source: "assistant" | "system" } | null;
  /** Pide que una persona haga algo ya (escalada, borrador por aprobar o cliente esperando). */
  needsAttention: boolean;
}

export interface MessageView {
  id: string;
  direction: "in" | "out";
  sender: "contact" | "bot" | "human";
  type: string;
  text: string;
  status: string;
  error: string | null;
  createdAt: Date;
}

function contactSummary(c: typeof contacts.$inferSelect): ContactSummary {
  const profile = (c.profile ?? {}) as Record<string, unknown>;
  // Apodo con el que se presenta en su red (WhatsApp, Messenger o Instagram).
  const nick = [profile.whatsapp_name, profile.messenger_name, profile.instagram_name].find((v) => typeof v === "string");
  const wa = typeof nick === "string" ? nick : null;
  return {
    id: c.id,
    name: c.displayName ?? wa ?? c.phoneE164 ?? "Cliente",
    hasRealName: Boolean(c.displayName),
    whatsappName: wa,
    phone: c.phoneE164,
  };
}

function viewText(m: Pick<typeof messages.$inferSelect, "direction" | "type" | "body" | "transcript">): string {
  if (m.type === "location" && m.direction === "out") {
    try {
      const l = JSON.parse(m.body ?? "{}") as { name?: string; address?: string };
      return `📍 Ubicación: ${[l.name, l.address].filter(Boolean).join(" · ")}`;
    } catch {
      return "📍 Ubicación";
    }
  }
  return messageText(m) || (m.type === "template" ? "[Plantilla]" : "");
}

const audit = (tx: Tx, ctx: PanelContext, action: string, conversationId: string, diff?: unknown) =>
  tx.insert(auditLog).values({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    action,
    entity: "conversation",
    entityId: conversationId,
    diff: (diff ?? null) as never,
  });

/** Las conversaciones del probador del panel no se mezclan con las de clientes reales. */
const REAL_CHANNEL = ne(channels.type, "playground");

interface Row {
  c: typeof conversations.$inferSelect;
  contact: typeof contacts.$inferSelect;
  channelType: string;
}

const toChannelKind = (t: string): ChannelKind => (t === "messenger" || t === "instagram" || t === "voice" ? t : "whatsapp");

/** Arma los resumenes de varias conversaciones con 3 consultas (no una por conversacion). */
async function summarize(tx: Tx, rows: Row[], now: Date): Promise<ConversationSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.c.id);
  const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);

  const [last, pending, open] = await Promise.all([
    tx.execute<{ conversation_id: string; direction: "in" | "out"; type: string; body: string | null; transcript: string | null }>(
      sql`select distinct on (conversation_id) conversation_id, direction, type, body, transcript
          from messages where conversation_id in (${idList})
          order by conversation_id, created_at desc`,
    ),
    tx
      .select({ id: approvals.conversationId, n: sql<number>`count(*)::int` })
      .from(approvals)
      .where(and(inArray(approvals.conversationId, ids), eq(approvals.status, "pending")))
      .groupBy(approvals.conversationId),
    tx
      .select()
      .from(handoffs)
      .where(and(inArray(handoffs.conversationId, ids), isNull(handoffs.resolvedAt))),
  ]);

  const lastBy = new Map(last.map((m) => [m.conversation_id, m]));
  const pendingBy = new Map(pending.map((p) => [p.id, p.n]));
  const handoffBy = new Map(open.map((h) => [h.conversationId, h]));

  return rows.map(({ c, contact, channelType }): ConversationSummary => {
    const lm = lastBy.get(c.id);
    const handoff = handoffBy.get(c.id);
    const pendingApprovals = pendingBy.get(c.id) ?? 0;
    const customerWaiting = c.state === "human" && lm?.direction === "in";
    return {
      id: c.id,
      channel: toChannelKind(channelType),
      state: c.state,
      assignedUserId: c.assignedUserId,
      contact: contactSummary(contact),
      lastMessageAt: c.lastMessageAt,
      lastInboundAt: c.lastInboundAt,
      windowOpen: isWithinServiceWindow(c.lastInboundAt, now),
      windowClosesAt: windowClosesAt(c.lastInboundAt),
      preview: lm
        ? viewText({ direction: lm.direction, type: lm.type as never, body: lm.body, transcript: lm.transcript }).slice(0, 120)
        : "",
      previewFromCustomer: lm?.direction === "in",
      pendingApprovals,
      handoff: handoff ? { urgency: handoff.urgency, reason: handoff.reason, summary: handoff.summary, source: handoff.source === "system" ? "system" : "assistant" } : null,
      needsAttention: c.state !== "closed" && (Boolean(handoff) || pendingApprovals > 0 || customerWaiting),
    };
  });
}

export async function listConversations(
  db: Database,
  ctx: PanelContext,
  options: { filter?: ConversationFilter; search?: string; limit?: number; now?: Date } = {},
): Promise<ConversationSummary[]> {
  const now = options.now ?? new Date();
  const limit = Math.min(options.limit ?? 60, 200);
  const search = options.search?.trim();
  const filter = options.filter ?? "all";

  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const rows = await tx
      .select({ c: conversations, contact: contacts, channelType: channels.type })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .innerJoin(channels, eq(channels.id, conversations.channelId))
      .where(
        and(
          REAL_CHANNEL,
          filter === "bot" || filter === "human" || filter === "closed" ? eq(conversations.state, filter) : undefined,
          search
            ? or(
                ilike(contacts.displayName, `%${search}%`),
                ilike(contacts.phoneE164, `%${search}%`),
                sql`${contacts.profile}->>'whatsapp_name' ilike ${`%${search}%`}`,
                sql`${contacts.profile}->>'messenger_name' ilike ${`%${search}%`}`,
                sql`${contacts.profile}->>'instagram_name' ilike ${`%${search}%`}`,
              )
            : undefined,
        ),
      )
      .orderBy(desc(sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`))
      // "attention" se filtra despues de calcular; se trae un margen para no quedarse corto.
      .limit(filter === "attention" ? 200 : limit);

    const items = await summarize(tx, rows, now);
    return filter === "attention" ? items.filter((i) => i.needsAttention).slice(0, limit) : items;
  });
}

export interface ConversationDetail extends ConversationSummary {
  messages: MessageView[];
  assignedUserName: string | null;
  approvals: Array<{ id: string; draft: string; createdAt: Date; actionSummaries: string[] }>;
}

export async function getConversation(
  db: Database,
  ctx: PanelContext,
  conversationId: string,
  options: { now?: Date; limit?: number } = {},
): Promise<ConversationDetail | null> {
  const now = options.now ?? new Date();

  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [row] = await tx
      .select({ c: conversations, contact: contacts, channelType: channels.type })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .innerJoin(channels, eq(channels.id, conversations.channelId))
      .where(and(eq(conversations.id, conversationId), REAL_CHANNEL));
    if (!row) return null;

    const [summary] = await summarize(tx, [row], now);
    const recent = await tx
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(options.limit ?? 200);
    const pending = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.conversationId, conversationId), eq(approvals.status, "pending")))
      .orderBy(asc(approvals.createdAt));

    let assignedUserName: string | null = null;
    if (row.c.assignedUserId) {
      const [u] = await tx
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, row.c.assignedUserId));
      assignedUserName = u ? (u.name ?? u.email) : null;
    }

    return {
      ...summary!,
      assignedUserName,
      messages: recent.reverse().map(
        (m): MessageView => ({
          id: m.id,
          direction: m.direction,
          sender: m.sender,
          type: m.type,
          text: viewText(m),
          status: m.status,
          error: m.error,
          createdAt: m.createdAt,
        }),
      ),
      approvals: pending.map((a) => ({
        id: a.id,
        draft: a.draft,
        createdAt: a.createdAt,
        actionSummaries: a.proposedActions.map((p) => p.summary),
      })),
    };
  });
}

// ------------------------------------------------------------------ acciones

async function loadReal(tx: Tx, conversationId: string) {
  const [row] = await tx
    .select({ c: conversations, channelType: channels.type })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(eq(conversations.id, conversationId));
  return row && row.channelType !== "playground" ? row.c : null;
}

const discardPending = (tx: Tx, ctx: PanelContext, conversationId: string) =>
  tx
    .update(approvals)
    .set({ status: "discarded", reviewedBy: ctx.userId, reviewedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(approvals.conversationId, conversationId), eq(approvals.status, "pending")));

const resolveHandoffs = (tx: Tx, conversationId: string) =>
  tx
    .update(handoffs)
    .set({ resolvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(handoffs.conversationId, conversationId), isNull(handoffs.resolvedAt)));

/** Una persona toma el control: el asistente deja de responder y los borradores pendientes se descartan. */
export async function takeControl(db: Database, ctx: PanelContext, conversationId: string): Promise<Result<{ state: "human" }>> {
  if (!can(ctx.role, "reply")) return fail("forbidden");
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const conv = await loadReal(tx, conversationId);
    if (!conv) return fail("not_found");
    if (conv.state === "closed") return fail("conversation_closed");

    await tx
      .update(conversations)
      .set({ state: "human", assignedUserId: ctx.userId, updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
    await tx
      .update(handoffs)
      .set({ takenBy: ctx.userId, updatedAt: new Date() })
      .where(and(eq(handoffs.conversationId, conversationId), isNull(handoffs.resolvedAt), isNull(handoffs.takenBy)));
    // Un borrador escrito antes de que una persona tomara el control ya no aplica.
    await discardPending(tx, ctx, conversationId);
    await audit(tx, ctx, "conversation.take_control", conversationId, {
      previous: conv.state,
      previousAssignee: conv.assignedUserId,
    });
    return { ok: true as const, state: "human" as const };
  });
}

/** Devuelve la conversacion al asistente y da por resuelta la escalada. */
export async function releaseControl(db: Database, ctx: PanelContext, conversationId: string): Promise<Result<{ state: "bot" }>> {
  if (!can(ctx.role, "reply")) return fail("forbidden");
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const conv = await loadReal(tx, conversationId);
    if (!conv) return fail("not_found");
    if (conv.state === "closed") return fail("conversation_closed");
    await tx
      .update(conversations)
      .set({ state: "bot", assignedUserId: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
    await resolveHandoffs(tx, conversationId);
    await audit(tx, ctx, "conversation.release", conversationId);
    return { ok: true as const, state: "bot" as const };
  });
}

export async function closeConversation(db: Database, ctx: PanelContext, conversationId: string): Promise<Result<{ state: "closed" }>> {
  if (!can(ctx.role, "reply")) return fail("forbidden");
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const conv = await loadReal(tx, conversationId);
    if (!conv) return fail("not_found");
    await tx
      .update(conversations)
      .set({ state: "closed", assignedUserId: null, updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
    await resolveHandoffs(tx, conversationId);
    await discardPending(tx, ctx, conversationId);
    await audit(tx, ctx, "conversation.close", conversationId);
    return { ok: true as const, state: "closed" as const };
  });
}

export type SendError = "forbidden" | "not_found" | "empty" | "too_long" | "not_in_control" | "window_closed" | "voice_channel";

/**
 * Una persona responde al cliente. Solo si ELLA tiene el control (el asistente esta pausado)
 * y la ventana de 24 h sigue abierta; fuera de ella WhatsApp solo admite plantillas.
 */
export async function sendHumanMessage(
  db: Database,
  ctx: PanelContext,
  conversationId: string,
  rawText: string,
  enqueue: EnqueueOutbound,
  now: Date = new Date(),
): Promise<Result<{ messageId: string }, SendError>> {
  if (!can(ctx.role, "reply")) return fail("forbidden");
  const text = rawText.trim();
  if (!text) return fail("empty");
  if (text.length > MAX_MESSAGE_CHARS) return fail("too_long");

  const outcome = await withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const conv = await loadReal(tx, conversationId);
    if (!conv) return fail("not_found" as const);
    if (conv.state !== "human" || conv.assignedUserId !== ctx.userId) return fail("not_in_control" as const);
    // Una llamada no se contesta por texto: si el cliente tiene WhatsApp se le escribe en esa conversacion.
    const [channel] = await tx.select({ type: channels.type }).from(channels).where(eq(channels.id, conv.channelId));
    if (channel?.type === "voice") return fail("voice_channel" as const);
    if (!isWithinServiceWindow(conv.lastInboundAt, now)) return fail("window_closed" as const);

    const [msg] = await tx
      .insert(messages)
      .values({
        tenantId: ctx.tenantId,
        conversationId,
        channelId: conv.channelId,
        direction: "out",
        sender: "human",
        type: "text",
        body: text,
        status: "queued",
      })
      .returning({ id: messages.id });
    await tx
      .update(conversations)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(eq(conversations.id, conversationId));
    return { ok: true as const, messageId: msg!.id };
  });
  if (!outcome.ok) return outcome;

  // Si la cola falla, el mensaje queda "queued" y el barrido de recuperacion lo envia.
  await enqueue({ tenantId: ctx.tenantId, messageId: outcome.messageId }).catch(() => {});
  return outcome;
}
