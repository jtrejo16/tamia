import {
  agentConfigs,
  contacts,
  conversations,
  messages,
  tenants,
  withTenant,
  type Database,
} from "@empleado/db";
import { and, count, eq } from "drizzle-orm";
import { modeFor, type Autonomy } from "./policy";
import type { TaskState, TurnContext } from "./types";

/**
 * Reconstruye el contexto de una conversacion fuera del bucle del modelo. Se usa, por
 * ejemplo, al ejecutar las acciones propuestas cuando una persona aprueba un borrador.
 */
export async function loadTurnContext(
  db: Database,
  tenantId: string,
  conversationId: string,
  options: { now?: Date; mode?: "live" | "dry"; skipConfirmation?: boolean } = {},
): Promise<TurnContext> {
  const loaded = await withTenant(db, { tenantId }, async (tx) => {
    const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, conversationId));
    if (!conversation) throw new Error("Conversacion no encontrada");
    const [contact] = await tx.select().from(contacts).where(eq(contacts.id, conversation.contactId));
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId));
    const [config] = await tx.select().from(agentConfigs).where(eq(agentConfigs.tenantId, tenantId));
    if (!contact || !tenant || !config) throw new Error("Datos del negocio incompletos");
    const [inbound] = await tx
      .select({ n: count() })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, "in")));
    return { conversation, contact, tenant, config, inboundCount: Number(inbound?.n ?? 0) };
  });

  return {
    db,
    tenantId,
    tenant: loaded.tenant,
    config: loaded.config,
    conversationId,
    contactId: loaded.contact.id,
    contact: loaded.contact,
    now: options.now ?? new Date(),
    inboundCount: loaded.inboundCount,
    taskState: { ...(loaded.conversation.taskState as TaskState) },
    mode: options.mode ?? modeFor(loaded.config.autonomy as Autonomy),
    skipConfirmation: options.skipConfirmation,
    proposedActions: [],
    attachments: [],
    usedMutation: false,
    escalated: false,
  };
}
