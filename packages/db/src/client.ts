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

/**
 * Ejecuta `fn` como un USUARIO, sin negocio fijado. Sirve para listar sus membresias al
 * iniciar sesion (la politica membership_self deja ver solo las propias).
 */
export async function withUser<T>(db: Database, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

/** Busca un usuario por correo ANTES de saber quien es (funcion SECURITY DEFINER). */
export interface AuthUser {
  id: string;
  email: string;
  passwordHash: string | null;
  sessionVersion: number;
  mustChangePassword: boolean;
}

export async function authFindUser(db: Database, email: string): Promise<AuthUser | null> {
  const rows = await db.execute<{
    id: string;
    email: string;
    password_hash: string | null;
    session_version: number;
    must_change_password: boolean;
  }>(sql`select * from auth_find_user(${email})`);
  const row = rows[0];
  return row
    ? {
        id: row.id,
        email: row.email,
        passwordHash: row.password_hash,
        sessionVersion: row.session_version,
        mustChangePassword: row.must_change_password,
      }
    : null;
}

/** Un dueno restablece la contrasena de alguien que pertenece SOLO a su negocio (ver la migracion 0006). */
export async function adminSetMemberPassword(
  db: Database,
  tenantId: string,
  actingUserId: string,
  memberId: string,
  passwordHash: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    await tx.execute(sql`select set_config('app.user_id', ${actingUserId}, true)`);
    const rows = await tx.execute<{ ok: boolean }>(sql`select admin_set_member_password(${memberId}, ${passwordHash}) as ok`);
    return rows[0]?.ok === true;
  });
}

export type ReminderKind = "24h" | "2h";

/** Recordatorios de cita que toca enviar ahora (de todos los negocios; solo ids). */
export async function dueReminders(
  db: Database,
  now: Date,
  limit = 100,
): Promise<Array<{ tenantId: string; appointmentId: string; kind: ReminderKind }>> {
  const rows = await db.execute<{ tenant_id: string; appointment_id: string; kind: ReminderKind }>(
    sql`select * from due_reminders(${now.toISOString()}::timestamptz, ${limit})`,
  );
  return rows.map((r) => ({ tenantId: r.tenant_id, appointmentId: r.appointment_id, kind: r.kind }));
}

/** Canales cuyas plantillas hay que sincronizar con Meta. */
export async function channelsForTemplateSync(db: Database): Promise<Array<{ tenantId: string; channelId: string }>> {
  const rows = await db.execute<{ tenant_id: string; channel_id: string }>(sql`select * from channels_for_template_sync()`);
  return rows.map((r) => ({ tenantId: r.tenant_id, channelId: r.channel_id }));
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

// ---------------------------------------------------------------- alta, cobro y operador (migracion 0008)

export interface SignupInput {
  name: string;
  slug: string;
  vertical: string;
  timezone: string;
  email: string;
  userName: string;
  passwordHash: string;
  model: string;
  fallbackModel: string;
  trialDays: number;
}

/** Registro publico: crea negocio pendiente + dueno + prueba gratis. No toca cuentas existentes. */
export async function signupCreateTenant(
  db: Database,
  i: SignupInput,
): Promise<{ ok: true; tenantId: string; userId: string } | { ok: false; error: "email_taken" | "slug_taken" }> {
  const rows = await db.execute<{ tenant_id: string | null; user_id: string | null; code: string }>(
    sql`select * from signup_create_tenant(${i.name}, ${i.slug}, ${i.vertical}, ${i.timezone}, ${i.email}, ${i.userName}, ${i.passwordHash}, ${i.model}, ${i.fallbackModel}, ${i.trialDays})`,
  );
  const row = rows[0];
  if (!row) throw new Error("signup_create_tenant no devolvio nada");
  if (row.code === "ok" && row.tenant_id && row.user_id) return { ok: true, tenantId: row.tenant_id, userId: row.user_id };
  return { ok: false, error: row.code === "slug_taken" ? "slug_taken" : "email_taken" };
}

/** El dueno inicia un checkout: guarda la suscripcion de Mercado Pago en curso y el plan elegido. */
export async function billingAttachPreapproval(
  db: Database,
  scope: { tenantId: string; userId: string },
  input: { preapprovalId: string; plan: string; payerEmail: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`);
    await tx.execute(sql`select set_config('app.user_id', ${scope.userId}, true)`);
    const rows = await tx.execute<{ ok: boolean }>(
      sql`select billing_attach_preapproval(${input.preapprovalId}, ${input.plan}::plan, ${input.payerEmail}) as ok`,
    );
    return rows[0]?.ok === true;
  });
}

/** Aplica el estado de una suscripcion de Mercado Pago (ya verificado contra su API). Devuelve el negocio o null. */
export async function billingApplyPreapproval(
  db: Database,
  input: { preapprovalId: string; mpStatus: string; nextPayment: Date | null },
): Promise<string | null> {
  const rows = await db.execute<{ t: string | null }>(
    sql`select billing_apply_preapproval(${input.preapprovalId}, ${input.mpStatus}, ${input.nextPayment?.toISOString() ?? null}::timestamptz) as t`,
  );
  return rows[0]?.t ?? null;
}

export interface OperatorTenantRow {
  id: string;
  name: string;
  slug: string;
  vertical: string;
  status: string;
  plan: string;
  createdAt: Date;
  subStatus: string | null;
  trialEndsAt: Date | null;
  cardAuthorized: boolean;
  ownerEmail: string | null;
  channelConnected: boolean;
}

const asOperator = <T>(db: Database, userId: string, fn: (tx: Tx) => Promise<T>) => withUser(db, userId, fn);

export async function operatorListTenants(db: Database, userId: string): Promise<OperatorTenantRow[]> {
  return asOperator(db, userId, async (tx) => {
    const rows = await tx.execute<{
      id: string; name: string; slug: string; vertical: string; status: string; plan: string; created_at: Date;
      sub_status: string | null; trial_ends_at: Date | null; card_authorized: boolean;
      owner_email: string | null; channel_connected: boolean;
    }>(sql`select * from operator_list_tenants()`);
    return rows.map((r) => ({
      id: r.id, name: r.name, slug: r.slug, vertical: r.vertical, status: r.status, plan: r.plan,
      createdAt: new Date(r.created_at), subStatus: r.sub_status,
      trialEndsAt: r.trial_ends_at ? new Date(r.trial_ends_at) : null,
      cardAuthorized: r.card_authorized, ownerEmail: r.owner_email, channelConnected: r.channel_connected,
    }));
  });
}

export async function operatorSetTenantStatus(db: Database, userId: string, tenantId: string, status: "active" | "paused" | "cancelled"): Promise<boolean> {
  return asOperator(db, userId, async (tx) => {
    const rows = await tx.execute<{ ok: boolean }>(sql`select operator_set_tenant_status(${tenantId}, ${status}) as ok`);
    return rows[0]?.ok === true;
  });
}

export async function operatorSetComped(db: Database, userId: string, tenantId: string, on: boolean): Promise<boolean> {
  return asOperator(db, userId, async (tx) => {
    const rows = await tx.execute<{ ok: boolean }>(sql`select operator_set_comped(${tenantId}, ${on}) as ok`);
    return rows[0]?.ok === true;
  });
}

/** El usuario es operador de la plataforma? (lo decide la base de datos con la sesion de ese usuario) */
export async function isOperator(db: Database, userId: string): Promise<boolean> {
  return asOperator(db, userId, async (tx) => {
    const rows = await tx.execute<{ ok: boolean }>(sql`select app_is_operator() as ok`);
    return rows[0]?.ok === true;
  });
}
