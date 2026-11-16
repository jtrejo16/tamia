import {
  approvals,
  auditLog,
  channels,
  contacts,
  conversations,
  messages,
  withTenant,
  type Database,
  type ProposedAction,
} from "@empleado/db";
import { applyApprovedActions, loadTurnContext, messageText } from "@empleado/agent";
import { isWithinServiceWindow } from "@empleado/channels";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { ContactSummary, MessageView } from "./conversations";
import { MAX_MESSAGE_CHARS, can, fail, type EnqueueOutbound, type Failure, type PanelContext, type Success } from "./types";

export interface ApprovalView {
  id: string;
  status: string;
  draft: string;
  /** Lo que realmente se envio, si una persona lo edito. */
  finalText: string | null;
  actions: Array<{ tool: string; summary: string }>;
  createdAt: Date;
  conversation: { id: string; state: "bot" | "human" | "closed"; windowOpen: boolean };
  contact: ContactSummary;
  /** Ultimos mensajes de la conversacion, para decidir con contexto. */
  context: MessageView[];
}

const CONTEXT_MESSAGES = 6;

export async function listApprovals(
  db: Database,
  ctx: PanelContext,
  options: { status?: "pending" | "reviewed"; limit?: number; now?: Date } = {},
): Promise<ApprovalView[]> {
  const now = options.now ?? new Date();
  const status = options.status ?? "pending";

  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const rows = await tx
      .select({ a: approvals, conv: conversations, contact: contacts })
      .from(approvals)
      .innerJoin(conversations, eq(conversations.id, approvals.conversationId))
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .innerJoin(channels, eq(channels.id, conversations.channelId))
      .where(
        and(
          ne(channels.type, "playground"),
          status === "pending" ? eq(approvals.status, "pending") : ne(approvals.status, "pending"),
        ),
      )
      .orderBy(status === "pending" ? approvals.createdAt : desc(approvals.updatedAt))
      .limit(Math.min(options.limit ?? 50, 200));
    if (rows.length === 0) return [];

    const ids = [...new Set(rows.map((r) => r.conv.id))];
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
    const recent = await tx.execute<{
      id: string;
      conversation_id: string;
      direction: "in" | "out";
      sender: "contact" | "bot" | "human";
      type: string;
      body: string | null;
      transcript: string | null;
      status: string;
      error: string | null;
      created_at: Date;
    }>(
      sql`select id, conversation_id, direction, sender, type, body, transcript, status, error, created_at
          from (
            select m.*, row_number() over (partition by conversation_id order by created_at desc) as rn
            from messages m where conversation_id in (${idList})
          ) t where rn <= ${CONTEXT_MESSAGES} order by created_at asc`,
    );
    const contextBy = new Map<string, MessageView[]>();
    for (const m of recent) {
      const list = contextBy.get(m.conversation_id) ?? [];
      list.push({
        id: m.id,
        direction: m.direction,
        sender: m.sender,
        type: m.type,
        text: messageText({ type: m.type as never, body: m.body, transcript: m.transcript }) || (m.type === "location" ? "📍 Ubicación" : ""),
        status: m.status,
        error: m.error,
        createdAt: m.created_at,
      });
      contextBy.set(m.conversation_id, list);
    }

    return rows.map(({ a, conv, contact }): ApprovalView => {
      const wa = ((contact.profile ?? {}) as Record<string, unknown>).whatsapp_name;
      return {
        id: a.id,
        status: a.status,
        draft: a.draft,
        finalText: a.finalText,
        actions: a.proposedActions.map((p) => ({ tool: p.tool, summary: p.summary })),
        createdAt: a.createdAt,
        conversation: { id: conv.id, state: conv.state, windowOpen: isWithinServiceWindow(conv.lastInboundAt, now) },
        contact: {
          id: contact.id,
          name: contact.displayName ?? (typeof wa === "string" ? wa : null) ?? contact.phoneE164 ?? "Cliente",
          hasRealName: Boolean(contact.displayName),
          whatsappName: typeof wa === "string" ? wa : null,
          phone: contact.phoneE164,
        },
        context: contextBy.get(conv.id) ?? [],
      };
    });
  });
}

export type ApproveError =
  | "forbidden"
  | "not_found"
  | "already_reviewed"
  | "conversation_in_human_control"
  | "window_closed"
  | "empty"
  | "too_long"
  | "actions_failed";

export type ApproveResult =
  | Success<{ messageId: string; edited: boolean; executed: string[] }>
  | (Failure<ApproveError> & { details?: string[] });

const describeFailure = (name: string, result: Record<string, unknown>): string => {
  const reason = (result.error ?? result.instruccion ?? "sin detalle") as string;
  return `${name}: ${reason}`;
};

/**
 * Aprueba un borrador del asistente (tal cual o editado), EJECUTA las acciones que proponia
 * (por ejemplo, crear la cita) y deja el mensaje en la cola de envio.
 *
 * Si una accion ya no se puede hacer (el horario se ocupo, etc.) NO se envia nada y el
 * borrador sigue pendiente, para que la persona lo corrija en vez de mandar una promesa falsa.
 */
export async function approveDraft(
  db: Database,
  ctx: PanelContext,
  approvalId: string,
  options: { text?: string; now?: Date } = {},
  enqueue: EnqueueOutbound,
): Promise<ApproveResult> {
  if (!can(ctx.role, "approve")) return fail("forbidden");
  const now = options.now ?? new Date();
  const scope = { tenantId: ctx.tenantId, userId: ctx.userId };

  // 1) Validar y reclamar el borrador (evita doble envio si se pulsa dos veces).
  const claimed = await withTenant(db, scope, async (tx) => {
    const [row] = await tx
      .select({ a: approvals, conv: conversations, channelType: channels.type })
      .from(approvals)
      .innerJoin(conversations, eq(conversations.id, approvals.conversationId))
      .innerJoin(channels, eq(channels.id, conversations.channelId))
      .where(eq(approvals.id, approvalId));
    if (!row || row.channelType === "playground") return fail("not_found" as const);
    if (row.a.status !== "pending") return fail("already_reviewed" as const);
    if (row.conv.state !== "bot") return fail("conversation_in_human_control" as const);
    if (!isWithinServiceWindow(row.conv.lastInboundAt, now)) return fail("window_closed" as const);

    const finalText = (options.text ?? row.a.draft).trim();
    if (!finalText) return fail("empty" as const);
    if (finalText.length > MAX_MESSAGE_CHARS) return fail("too_long" as const);

    const taken = await tx
      .update(approvals)
      .set({ status: "approved", reviewedBy: ctx.userId, reviewedAt: now, updatedAt: now })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
      .returning({ id: approvals.id });
    if (taken.length === 0) return fail("already_reviewed" as const);

    return { ok: true as const, approval: row.a, conv: row.conv, finalText };
  });
  if (!claimed.ok) return claimed;
  const { approval, conv, finalText } = claimed;

  // 2) Ejecutar lo que el asistente proponia.
  const executed: string[] = [];
  const actions: ProposedAction[] = approval.proposedActions;
  if (actions.length > 0) {
    const turn = await loadTurnContext(db, ctx.tenantId, conv.id, { now });
    const runs = await applyApprovedActions(turn, actions);
    const failures = runs.filter((r) => r.result.ok !== true);
    for (const r of runs) if (r.result.ok === true) executed.push(r.name);
    if (failures.length > 0) {
      // Se devuelve el borrador a "pendiente": nada se envia y la persona decide.
      await withTenant(db, scope, (tx) =>
        tx
          .update(approvals)
          .set({ status: "pending", reviewedBy: null, reviewedAt: null, updatedAt: new Date() })
          .where(eq(approvals.id, approvalId)),
      );
      return { ok: false, error: "actions_failed", details: failures.map((f) => describeFailure(f.name, f.result)) };
    }
  }

  // 3) Guardar el mensaje de salida y cerrar la revision.
  const edited = finalText !== approval.draft.trim();
  const messageId = await withTenant(db, scope, async (tx) => {
    const [msg] = await tx
      .insert(messages)
      .values({
        tenantId: ctx.tenantId,
        conversationId: conv.id,
        channelId: conv.channelId,
        direction: "out",
        sender: edited ? "human" : "bot",
        type: "text",
        body: finalText,
        status: "queued",
      })
      .returning({ id: messages.id });
    await tx
      .update(approvals)
      .set({ status: edited ? "edited" : "approved", finalText, updatedAt: new Date() })
      .where(eq(approvals.id, approvalId));
    await tx.update(conversations).set({ lastMessageAt: now, updatedAt: now }).where(eq(conversations.id, conv.id));
    await tx.insert(auditLog).values({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: edited ? "approval.edited" : "approval.approved",
      entity: "approval",
      entityId: approvalId,
      diff: { executed, edited },
    });
    return msg!.id;
  });

  await enqueue({ tenantId: ctx.tenantId, messageId }).catch(() => {});
  return { ok: true, messageId, edited, executed };
}

export async function discardDraft(
  db: Database,
  ctx: PanelContext,
  approvalId: string,
): Promise<Success | Failure<"forbidden" | "not_found" | "already_reviewed">> {
  if (!can(ctx.role, "approve")) return fail("forbidden");
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [row] = await tx.select().from(approvals).where(eq(approvals.id, approvalId));
    if (!row) return fail("not_found" as const);
    const updated = await tx
      .update(approvals)
      .set({ status: "discarded", reviewedBy: ctx.userId, reviewedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
      .returning({ id: approvals.id });
    if (updated.length === 0) return fail("already_reviewed" as const);
    await tx.insert(auditLog).values({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "approval.discarded",
      entity: "approval",
      entityId: approvalId,
    });
    return { ok: true as const };
  });
}
