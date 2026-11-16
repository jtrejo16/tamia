import { channels, messages, withTenant, type Database, type ProposedAction } from "@empleado/db";
import { ensureConversation, runAgentTurn, type Attachment, type ToolRun } from "@empleado/agent";
import type { LLMProvider } from "@empleado/llm";
import { and, eq } from "drizzle-orm";
import { can, fail, type PanelContext, type Result } from "./types";

export interface PlaygroundTurn {
  conversationId: string;
  /** send/draft segun la autonomia del negocio; none si el asistente esta pausado. */
  action: "send" | "draft" | "none";
  reason?: string;
  text: string | null;
  escalated: boolean;
  failure?: string;
  proposedActions: ProposedAction[];
  attachments: Attachment[];
  toolTrace: Array<{ name: string; args: unknown; result: Record<string, unknown> }>;
  usage: { calls: number; tokensIn: number; tokensOut: number; costUsd: number; models: string[] };
}

/** El canal "playground" no envia nada a ningun lado: solo existe para probar el agente. */
async function ensurePlaygroundChannel(db: Database, tenantId: string): Promise<string> {
  return withTenant(db, { tenantId }, async (tx) => {
    await tx
      .insert(channels)
      .values({ tenantId, type: "playground", externalId: `playground-${tenantId}`, status: "active" })
      .onConflictDoNothing();
    const [row] = await tx.select({ id: channels.id }).from(channels).where(eq(channels.type, "playground"));
    return row!.id;
  });
}

/**
 * Una vuelta de conversacion de prueba: usa el MISMO agente que WhatsApp (herramientas,
 * memoria, nivel de autonomia), pero con un cliente ficticio y sin enviar nada al exterior.
 * `sessionKey` identifica la conversacion; con otra clave se empieza de cero.
 */
export async function runPlaygroundTurn(
  db: Database,
  llm: LLMProvider,
  ctx: PanelContext,
  input: { text: string; sessionKey: string; now?: Date },
): Promise<Result<{ turn: PlaygroundTurn }, "forbidden" | "empty" | "bad_session">> {
  if (!can(ctx.role, "playground")) return fail("forbidden");
  const text = input.text.trim();
  if (!text) return fail("empty");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(input.sessionKey)) return fail("bad_session");

  const channelId = await ensurePlaygroundChannel(db, ctx.tenantId);
  const ref = await ensureConversation(db, {
    tenantId: ctx.tenantId,
    channelId,
    phone: `playground:${ctx.userId}:${input.sessionKey}`,
    name: "Cliente de prueba",
  });

  const result = await runAgentTurn({
    db,
    llm,
    tenantId: ctx.tenantId,
    conversationId: ref.conversationId,
    text,
    now: input.now,
  });

  // Nada sale a WhatsApp: lo que quedo "en cola" se da por enviado.
  await withTenant(db, { tenantId: ctx.tenantId }, (tx) =>
    tx
      .update(messages)
      .set({ status: "sent", updatedAt: new Date() })
      .where(and(eq(messages.conversationId, ref.conversationId), eq(messages.direction, "out"), eq(messages.status, "queued"))),
  );

  return {
    ok: true,
    turn: {
      conversationId: ref.conversationId,
      action: result.action,
      reason: result.reason,
      text: result.text,
      escalated: result.escalated,
      failure: result.failure,
      proposedActions: result.proposedActions,
      attachments: result.attachments,
      toolTrace: result.toolTrace.map((t: ToolRun) => ({
        name: t.name,
        args: t.args,
        result: t.result,
      })),
      usage: {
        calls: result.usage.calls,
        tokensIn: result.usage.tokensIn,
        tokensOut: result.usage.tokensOut,
        costUsd: result.usage.costUsd,
        models: result.usage.models,
      },
    },
  };
}
