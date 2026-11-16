import { ensureConversation, runAgentTurn } from "@empleado/agent";
import type { InboundJobData, OutboundJobData } from "@empleado/channels";
import type { Database } from "@empleado/db";
import type { LLMProvider } from "@empleado/llm";
import type { Logger } from "../config";
import type { Lock } from "../lock";
import { enqueueQueuedMessages } from "../outbox";
import type { RateLimiter } from "../ratelimit";

/** Tope por cliente: protege contra spam y contra una factura de IA descontrolada. */
export const MAX_MESSAGES_PER_HOUR = 30;

export interface InboundDeps {
  /** Conexion del rol de la APLICACION (RLS aplica). */
  db: Database;
  llm: LLMProvider;
  enqueueOutbound(job: OutboundJobData): Promise<void>;
  lock: Lock;
  limiter: RateLimiter;
  /** Palomitas azules; mejor esfuerzo, no bloquea el turno. */
  markRead?: (job: InboundJobData) => Promise<void>;
  now?: () => Date;
  log?: Logger;
}

export type InboundResult =
  | { status: "processed"; action: "send" | "draft" | "none"; queued: string[]; escalated: boolean; reason?: string }
  | { status: "skipped"; reason: "rate_limited" };

export function createInboundProcessor(deps: InboundDeps) {
  const log = deps.log ?? (() => {});

  return async (job: InboundJobData): Promise<InboundResult> => {
    const { tenantId, channelId, message } = job;

    const allowed = await deps.limiter.allow(
      `inbound:${tenantId}:${message.from}`,
      MAX_MESSAGES_PER_HOUR,
      3600,
    );
    if (!allowed) {
      log("inbound.rate_limited", { tenantId, from: message.from });
      return { status: "skipped", reason: "rate_limited" };
    }

    const ref = await ensureConversation(deps.db, {
      tenantId,
      channelId,
      phone: `+${message.from}`,
      profileName: job.contactName,
    });

    if (deps.markRead) void deps.markRead(job).catch(() => {});

    // Un mensaje a la vez por conversacion: si el cliente manda tres seguidos, el agente
    // contesta en orden y ve lo que ya respondio.
    return deps.lock.withLock(`conv:${ref.conversationId}`, async () => {
      const result = await runAgentTurn({
        db: deps.db,
        llm: deps.llm,
        tenantId,
        conversationId: ref.conversationId,
        text: message.text,
        type: message.type,
        mediaUrl: message.mediaId ? `wa-media:${message.mediaId}` : undefined,
        externalMessageId: message.id,
        now: deps.now?.(),
      });

      const queued =
        result.action === "send"
          ? await enqueueQueuedMessages(deps.db, tenantId, ref.conversationId, deps.enqueueOutbound)
          : [];

      log("inbound.processed", {
        tenantId,
        conversationId: ref.conversationId,
        action: result.action,
        reason: result.reason,
        escalated: result.escalated,
        failure: result.failure,
        llmCalls: result.usage.calls,
        costUsd: result.usage.costUsd,
      });
      return {
        status: "processed" as const,
        action: result.action,
        queued,
        escalated: result.escalated,
        reason: result.reason,
      };
    });
  };
}
