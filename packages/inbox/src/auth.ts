import { authFindUser, memberships, tenants, users, withTenant, withUser, type Database } from "@empleado/db";
import { verifyAgainstDummy, verifyPassword, type SessionRole } from "@empleado/shared";
import { eq } from "drizzle-orm";

export interface Login {
  userId: string;
  userName: string | null;
  email: string;
  tenantId: string;
  tenantName: string;
  role: SessionRole;
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

  // Con varios negocios se entra al de mayor rol; el selector de negocio llega despues.
  const chosen = [...rows].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role])[0]!;
  const [tenant] = await withTenant(db, { tenantId: chosen.tenantId, userId: user.id }, (tx) =>
    tx.select().from(tenants).where(eq(tenants.id, chosen.tenantId)),
  );
  if (!tenant) return { ok: false, error: "no_membership" };
  if (tenant.status !== "active") return { ok: false, error: "tenant_inactive" };

  // users tiene RLS: cada quien ve su propia fila (app.user_id).
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
    },
  };
}
