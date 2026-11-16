import { messages, staleQueuedMessages, withTenant, type Database } from "@empleado/db";
import { and, asc, eq } from "drizzle-orm";

/**
 * Encola el envio de los mensajes salientes pendientes de una conversacion.
 * Los guarda el agente (o una persona desde el panel) con status "queued".
 */
export async function enqueueQueuedMessages(
  db: Database,
  tenantId: string,
  conversationId: string,
  enqueue: (job: { tenantId: string; messageId: string }) => Promise<void>,
): Promise<string[]> {
  const rows = await withTenant(db, { tenantId }, (tx) =>
    tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.direction, "out"),
          eq(messages.status, "queued"),
        ),
      )
      .orderBy(asc(messages.createdAt), asc(messages.type)),
  );
  for (const row of rows) await enqueue({ tenantId, messageId: row.id });
  return rows.map((r) => r.id);
}

/**
 * Barrido de recuperacion: si el proceso se cayo entre guardar un mensaje y encolarlo,
 * aqui se vuelve a encolar. El jobId evita duplicados si el trabajo sigue vivo.
 */
export async function sweepStaleMessages(
  db: Database,
  enqueue: (job: { tenantId: string; messageId: string }) => Promise<void>,
  olderThanSeconds = 60,
  limit = 200,
): Promise<number> {
  const stale = await staleQueuedMessages(db, olderThanSeconds, limit);
  for (const s of stale) await enqueue(s);
  return stale.length;
}
