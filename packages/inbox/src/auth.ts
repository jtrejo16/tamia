import {
  authFindUser,
  memberships,
  tenants,
  users,
  withTenant,
  withUser,
  type Database,
} from "@empleado/db";
import { verifyAgainstDummy, verifyPassword, type SessionRole } from "@empleado/shared";
import { and, eq } from "drizzle-orm";

export interface Login {
  userId: string;
  userName: string | null;
  email: string;
  tenantId: string;
  tenantName: string;
  role: SessionRole;
  /** Version de sesiones con la que se debe emitir la cookie. */
  sessionVersion: number;
  mustChangePassword: boolean;
}

export type AuthResult =
  | { ok: true; login: Login }
  | { ok: false; error: "invalid_credentials" | "no_membership" | "tenant_inactive" };

const ROLE_ORDER: Record<SessionRole, number> = { owner: 0, agent: 1, viewer: 2 };

/**
 * Valida correo y contrasena. Responde igual (y tarda igual) si el correo no existe que si
 * la contrasena es incorrecta, para no revelar quien tiene cuenta.
 */
export async function authenticate(db: Database, email: string, password: string): Promise<AuthResult> {
  const user = await authFindUser(db, email.trim());
  const valid = user ? await verifyPassword(password, user.passwordHash) : await verifyAgainstDummy(password);
  if (!user || !valid) return { ok: false, error: "invalid_credentials" };

  const rows = await withUser(db, user.id, (tx) =>
    tx
      .select({ tenantId: memberships.tenantId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, user.id)),
  );
  if (rows.length === 0) return { ok: false, error: "no_membership" };

  // Con varios negocios se entra al de mayor rol; despues se puede cambiar de negocio.
  const chosen = [...rows].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role])[0]!;
  const [tenant] = await withTenant(db, { tenantId: chosen.tenantId, userId: user.id }, (tx) =>
    tx.select().from(tenants).where(eq(tenants.id, chosen.tenantId)),
  );
  if (!tenant) return { ok: false, error: "no_membership" };
  if (tenant.status !== "active" && tenant.status !== "pending") return { ok: false, error: "tenant_inactive" };

  const [self] = await withUser(db, user.id, (tx) =>
    tx.select({ name: users.name }).from(users).where(eq(users.id, user.id)),
  );

  return {
    ok: true,
    login: {
      userId: user.id,
      userName: self?.name ?? null,
      email: user.email,
      tenantId: tenant.id,
      tenantName: tenant.name,
      role: chosen.role,
      sessionVersion: user.sessionVersion,
      mustChangePassword: user.mustChangePassword,
    },
  };
}

export type SessionState =
  | {
      ok: true;
      role: SessionRole;
      userName: string | null;
      email: string;
      tenantName: string;
      timezone: string;
      mustChangePassword: boolean;
    }
  | { ok: false; reason: "revoked" | "no_membership" | "tenant_inactive" };

/**
 * Comprueba CONTRA LA BASE DE DATOS que una sesion sigue valida: que no se revoco (version de
 * sesiones), que el usuario sigue en ese negocio y que el negocio esta activo. De aqui sale el
 * rol vigente: un cambio de rol o una baja surten efecto en la siguiente peticion.
 */
export async function getSessionState(
  db: Database,
  session: { uid: string; tid: string; sv: number },
): Promise<SessionState> {
  return withTenant(db, { tenantId: session.tid, userId: session.uid }, async (tx) => {
    const [user] = await tx
      .select({
        sv: users.sessionVersion,
        mustChange: users.mustChangePassword,
        name: users.name,
        email: users.email,
      })
      .from(users)
      .where(eq(users.id, session.uid));
    if (!user || user.sv !== session.sv) return { ok: false as const, reason: "revoked" as const };

    const [member] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, session.uid), eq(memberships.tenantId, session.tid)));
    if (!member) return { ok: false as const, reason: "no_membership" as const };

    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, session.tid));
    if (!tenant) return { ok: false as const, reason: "no_membership" as const };
    if (tenant.status !== "active" && tenant.status !== "pending") return { ok: false as const, reason: "tenant_inactive" as const };

    return {
      ok: true as const,
      role: member.role,
      userName: user.name,
      email: user.email,
      tenantName: tenant.name,
      timezone: tenant.timezone,
      mustChangePassword: user.mustChange,
    };
  });
}
