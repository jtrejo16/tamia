import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;
/** Transaccion de Drizzle; tiene la misma API de consultas que Database. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DbHandle {
  db: Database;
  close: () => Promise<void>;
}

/** Abre una conexion. Para la app usa DATABASE_APP_URL (rol sin superusuario: respeta RLS). */
export function createDb(url: string, options: { max?: number } = {}): DbHandle {
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => {} });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}

export interface RequestContext {
  tenantId: string;
  userId?: string;
}

/**
 * Ejecuta `fn` dentro de una transaccion con el tenant fijado.
 * set_config(..., true) limita el valor a ESTA transaccion, asi una conexion del pool
 * nunca arrastra el tenant de una peticion anterior.
 */
export async function withTenant<T>(
  db: Database,
  ctx: RequestContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${ctx.tenantId}, true)`);
    await tx.execute(sql`select set_config('app.user_id', ${ctx.userId ?? ""}, true)`);
    return fn(tx);
  });
}

/** Mensajes salientes que llevan mas de `olderThanSeconds` en cola (barrido de recuperacion). */
export async function staleQueuedMessages(
  db: Database,
  olderThanSeconds: number,
  limit = 200,
): Promise<Array<{ tenantId: string; messageId: string }>> {
  const rows = await db.execute<{ tenant_id: string; message_id: string }>(
    sql`select * from stale_queued_messages(${olderThanSeconds}, ${limit})`,
  );
  return rows.map((r) => ({ tenantId: r.tenant_id, messageId: r.message_id }));
}

/** Resuelve webhook -> tenant/canal sin contexto previo (funcion SECURITY DEFINER). */
export async function resolveChannel(
  db: Database,
  type: string,
  externalId: string,
): Promise<{ tenantId: string; channelId: string } | null> {
  const rows = await db.execute<{ tenant_id: string; channel_id: string }>(
    sql`select * from resolve_channel(${type}, ${externalId})`,
  );
  const row = rows[0];
  return row ? { tenantId: row.tenant_id, channelId: row.channel_id } : null;
}
