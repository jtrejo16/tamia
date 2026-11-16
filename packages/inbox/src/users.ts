import {
  adminSetMemberPassword,
  auditLog,
  authFindUser,
  memberships,
  tenants,
  users,
  withTenant,
  withUser,
  type Database,
} from "@empleado/db";
import { assertPasswordStrength, hashPassword, verifyPassword, type SessionRole } from "@empleado/shared";
import { asc, eq, sql } from "drizzle-orm";
import { randomInt, randomUUID } from "node:crypto";
import { can, fail, type Failure, type PanelContext, type Success } from "./types";

const ROLES: readonly SessionRole[] = ["owner", "agent", "viewer"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Sin caracteres ambiguos (0/O, 1/l/I): la contrasena temporal se dicta o se copia a mano.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** "Xk3f-9Hqa-Wm2p": 12 caracteres al azar (criptograficamente seguros) en grupos de 4. */
export function generateTemporaryPassword(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]!);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((g) => g.join("")).join("-");
}

const scope = (ctx: PanelContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });
const record = (ctx: PanelContext, action: string, entityId: string, diff?: unknown) => ({
  tenantId: ctx.tenantId,
  userId: ctx.userId,
  action: `user.${action}`,
  entity: "user",
  entityId,
  diff: (diff ?? null) as never,
});

export interface MemberView {
  userId: string;
  email: string;
  name: string | null;
  role: SessionRole;
  isYou: boolean;
  mustChangePassword: boolean;
}

export async function listMembers(db: Database, ctx: PanelContext): Promise<MemberView[]> {
  return withTenant(db, scope(ctx), async (tx) => {
    const rows = await tx
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: memberships.role,
        mustChange: users.mustChangePassword,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .orderBy(asc(memberships.role), asc(users.email));
    return rows.map((r): MemberView => ({
      userId: r.userId,
      email: r.email,
      name: r.name,
      role: r.role,
      isYou: r.userId === ctx.userId,
      mustChangePassword: r.mustChange,
    }));
  });
}

export type UserError =
  | "forbidden"
  | "invalid"
  | "not_found"
  | "already_member"
  | "last_owner"
  | "cannot_reset"
  | "use_own_password"
  | "email_taken";

type Fail = Failure<UserError> & { details?: string[] };

export async function addMember(
  db: Database,
  ctx: PanelContext,
  input: { email: string; name?: string; role: string },
): Promise<Success<{ userId: string; created: boolean; temporaryPassword?: string }> | Fail> {
  if (!can(ctx.role, "manage_users")) return fail("forbidden");
  const email = input.email.trim().toLowerCase();
  const name = input.name?.trim() || null;
  if (!EMAIL.test(email) || email.length > 160) return { ...fail("invalid"), details: ["Escribe un correo válido"] };
  if (!ROLES.includes(input.role as SessionRole)) return { ...fail("invalid"), details: ["Rol no válido"] };
  if (name && name.length > 120) return { ...fail("invalid"), details: ["El nombre es demasiado largo"] };
  const role = input.role as SessionRole;

  const existing = await authFindUser(db, email);
  const temporaryPassword = existing ? undefined : generateTemporaryPassword();
  const passwordHash = temporaryPassword ? await hashPassword(temporaryPassword) : null;
  const userId = existing?.id ?? randomUUID();

  try {
    return await withTenant(db, scope(ctx), async (tx) => {
      if (existing) {
        const [already] = await tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.userId, existing.id));
        if (already) return fail("already_member" as const);
      } else {
        // Sin RETURNING: la politica de lectura de users solo deja ver a quien ya es del negocio.
        await tx.insert(users).values({ id: userId, email, name, passwordHash, mustChangePassword: true });
      }
      await tx.insert(memberships).values({ tenantId: ctx.tenantId, userId, role });
      await tx.insert(auditLog).values(record(ctx, "added", userId, { email, role, createdAccount: !existing }));
      return { ok: true as const, userId, created: !existing, ...(temporaryPassword ? { temporaryPassword } : {}) };
    });
  } catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === "23505") return fail("email_taken");
    throw error;
  }
}

async function ownerCount(tx: Parameters<Parameters<typeof withTenant>[2]>[0]): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.role, "owner"));
  return Number(row?.n ?? 0);
}

/** Cambia el rol. Siempre debe quedar al menos UN dueno en el negocio. */
export async function changeRole(
  db: Database,
  ctx: PanelContext,
  userId: string,
  role: string,
): Promise<Success<{ role: SessionRole }> | Fail> {
  if (!can(ctx.role, "manage_users")) return fail("forbidden");
  if (!ROLES.includes(role as SessionRole)) return { ...fail("invalid"), details: ["Rol no válido"] };

  return withTenant(db, scope(ctx), async (tx) => {
    const [member] = await tx.select().from(memberships).where(eq(memberships.userId, userId));
    if (!member) return fail("not_found" as const);
    if (member.role === "owner" && role !== "owner" && (await ownerCount(tx)) <= 1) return fail("last_owner" as const);
    await tx.update(memberships).set({ role: role as SessionRole, updatedAt: new Date() }).where(eq(memberships.id, member.id));
    await tx.insert(auditLog).values(record(ctx, "role_changed", userId, { from: member.role, to: role }));
    return { ok: true as const, role: role as SessionRole };
  });
}

/** Da de baja a alguien del negocio: pierde el acceso en su siguiente peticion. */
export async function removeMember(db: Database, ctx: PanelContext, userId: string): Promise<Success | Fail> {
  if (!can(ctx.role, "manage_users")) return fail("forbidden");
  return withTenant(db, scope(ctx), async (tx) => {
    const [member] = await tx.select().from(memberships).where(eq(memberships.userId, userId));
    if (!member) return fail("not_found" as const);
    if (member.role === "owner" && (await ownerCount(tx)) <= 1) return fail("last_owner" as const);
    await tx.delete(memberships).where(eq(memberships.id, member.id));
    await tx.insert(auditLog).values(record(ctx, "removed", userId, { role: member.role }));
    return { ok: true as const };
  });
}

/**
 * Restablece la contrasena de alguien del negocio: queda una temporal (que debe cambiar) y se
 * cierran sus sesiones. Solo si esa persona pertenece UNICAMENTE a este negocio.
 */
export async function resetMemberPassword(
  db: Database,
  ctx: PanelContext,
  userId: string,
): Promise<Success<{ temporaryPassword: string }> | Fail> {
  if (!can(ctx.role, "manage_users")) return fail("forbidden");
  if (userId === ctx.userId) return fail("use_own_password");

  const temporaryPassword = generateTemporaryPassword();
  const done = await adminSetMemberPassword(db, ctx.tenantId, ctx.userId, userId, await hashPassword(temporaryPassword));
  if (!done) return fail("cannot_reset");
  await withTenant(db, scope(ctx), (tx) => tx.insert(auditLog).values(record(ctx, "password_reset", userId)));
  return { ok: true, temporaryPassword };
}

// ------------------------------------------------------------- cuenta propia

export type AccountError = "wrong_password" | "weak_password" | "same_password" | "not_found";

/**
 * Cambia la contrasena propia (pide la actual). Cierra las demas sesiones y devuelve la nueva
 * version para que ESTE dispositivo siga con sesion.
 */
export async function changeOwnPassword(
  db: Database,
  ctx: PanelContext,
  current: string,
  next: string,
): Promise<Success<{ sessionVersion: number }> | (Failure<AccountError> & { details?: string[] })> {
  const [me] = await withUser(db, ctx.userId, (tx) => tx.select({ email: users.email }).from(users).where(eq(users.id, ctx.userId)));
  if (!me) return fail("not_found");
  const user = await authFindUser(db, me.email);
  if (!user || !(await verifyPassword(current, user.passwordHash))) return fail("wrong_password");
  try {
    assertPasswordStrength(next);
  } catch (e) {
    return { ...fail("weak_password"), details: [e instanceof Error ? e.message : "Contraseña débil"] };
  }
  if (next === current) return fail("same_password");

  const hash = await hashPassword(next);
  return withUser(db, ctx.userId, async (tx) => {
    const [row] = await tx
      .update(users)
      .set({ passwordHash: hash, mustChangePassword: false, sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: new Date() })
      .where(eq(users.id, ctx.userId))
      .returning({ sv: users.sessionVersion });
    return { ok: true as const, sessionVersion: row!.sv };
  });
}

/** Cierra TODAS las sesiones del usuario, en todos los dispositivos (incluida esta). */
export async function signOutEverywhere(db: Database, userId: string): Promise<void> {
  await withUser(db, userId, (tx) =>
    tx.update(users).set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: new Date() }).where(eq(users.id, userId)),
  );
}

export interface MyTenant {
  tenantId: string;
  name: string;
  role: SessionRole;
}

/** Los negocios a los que pertenece el usuario (para cambiar de uno a otro). */
export async function listMyTenants(db: Database, userId: string): Promise<MyTenant[]> {
  const rows = await withUser(db, userId, (tx) =>
    tx.select({ tenantId: memberships.tenantId, role: memberships.role }).from(memberships).where(eq(memberships.userId, userId)),
  );
  const out: MyTenant[] = [];
  for (const r of rows) {
    const [t] = await withTenant(db, { tenantId: r.tenantId, userId }, (tx) => tx.select().from(tenants).where(eq(tenants.id, r.tenantId)));
    if (t && t.status === "active") out.push({ tenantId: t.id, name: t.name, role: r.role });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Confirma que el usuario realmente pertenece al negocio al que quiere cambiar. */
export async function canSwitchTo(db: Database, userId: string, tenantId: string): Promise<MyTenant | null> {
  return (await listMyTenants(db, userId)).find((t) => t.tenantId === tenantId) ?? null;
}
