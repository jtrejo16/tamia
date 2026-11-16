import { auditLog, memberships, tenants, users } from "@empleado/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMember,
  authenticate,
  canSwitchTo,
  changeOwnPassword,
  changeRole,
  generateTemporaryPassword,
  getSessionState,
  listMembers,
  listMyTenants,
  removeMember,
  resetMemberPassword,
  signOutEverywhere,
} from "../src";
import { PASSWORD, dropWorld, makeWorld, openDbs, type Dbs, type World } from "./helpers";

let dbs: Dbs;
const worlds: World[] = [];
const extraUsers: string[] = [];
beforeAll(() => {
  dbs = openDbs();
});
afterAll(async () => {
  for (const w of worlds) await dropWorld(dbs.owner, w);
  for (const id of extraUsers) await dbs.owner.db.delete(users).where(eq(users.id, id));
  await dbs.app.close();
  await dbs.owner.close();
});

async function world() {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  return w;
}
const emailOf = async (userId: string) => (await dbs.owner.db.select().from(users).where(eq(users.id, userId)))[0]!.email;
const userRow = async (userId: string) => (await dbs.owner.db.select().from(users).where(eq(users.id, userId)))[0]!;
const fresh = () => `nuevo-${Math.random().toString(36).slice(2, 10)}@test.local`;
const sessionOf = async (w: World, userId: string) => ({ uid: userId, tid: w.tenantId, sv: (await userRow(userId)).sessionVersion });

describe("contraseña temporal", () => {
  it("12 caracteres sin ambiguos, en grupos, distinta cada vez", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = generateTemporaryPassword();
      expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}$/);
      seen.add(p);
    }
    expect(seen.size).toBe(50);
  });
});

describe("alta de usuarios", () => {
  it("crea la cuenta con contraseña temporal que obliga a cambiarla, y esa contraseña sirve para entrar", async () => {
    const w = await world();
    const email = fresh();
    const r = await addMember(dbs.app.db, w.owner, { email: `  ${email.toUpperCase()} `, name: "Rosa Díaz", role: "agent" });
    expect(r).toMatchObject({ ok: true, created: true });
    const added = r as { userId: string; temporaryPassword: string };
    extraUsers.push(added.userId);

    const login = await authenticate(dbs.app.db, email, added.temporaryPassword);
    expect(login.ok && login.login).toMatchObject({ tenantId: w.tenantId, role: "agent", userName: "Rosa Díaz", mustChangePassword: true });

    const members = await listMembers(dbs.app.db, w.owner);
    expect(members.find((m) => m.userId === added.userId)).toMatchObject({ email, role: "agent", mustChangePassword: true, isYou: false });
    expect(members.find((m) => m.userId === w.ownerId)!.isYou).toBe(true);
    const log = await dbs.owner.db.select().from(auditLog).where(and(eq(auditLog.tenantId, w.tenantId), eq(auditLog.action, "user.added")));
    expect(log[0]!.diff).toMatchObject({ email, role: "agent", createdAccount: true });
    expect(JSON.stringify(log[0]!.diff)).not.toContain(added.temporaryPassword); // la contraseña NUNCA va a la bitacora
  });

  it("si el correo ya existe (otro negocio) solo se le da acceso: su contraseña no se toca", async () => {
    const a = await world();
    const b = await world();
    const email = await emailOf(b.viewerId);
    const r = await addMember(dbs.app.db, a.owner, { email, role: "viewer" });
    expect(r).toMatchObject({ ok: true, created: false });
    expect(r).not.toHaveProperty("temporaryPassword");
    expect((await userRow(b.viewerId)).mustChangePassword).toBe(false);
    expect((await authenticate(dbs.app.db, email, PASSWORD)).ok).toBe(true); // su contraseña de siempre sigue sirviendo
    expect((await listMyTenants(dbs.app.db, b.viewerId)).map((t) => t.tenantId).sort()).toEqual([a.tenantId, b.tenantId].sort());
  });

  it("no se agrega dos veces al mismo negocio, y valida correo y rol", async () => {
    const w = await world();
    const email = await emailOf(w.agentId);
    expect(await addMember(dbs.app.db, w.owner, { email, role: "agent" })).toEqual({ ok: false, error: "already_member" });
    for (const bad of [{ email: "no-es-correo", role: "agent" }, { email: fresh(), role: "superadmin" }, { email: fresh(), role: "agent", name: "x".repeat(200) }]) {
      expect(await addMember(dbs.app.db, w.owner, bad)).toMatchObject({ ok: false, error: "invalid" });
    }
  });

  it("solo el dueño administra usuarios", async () => {
    const w = await world();
    for (const ctx of [w.agent, w.viewer]) {
      expect(await addMember(dbs.app.db, ctx, { email: fresh(), role: "viewer" })).toEqual({ ok: false, error: "forbidden" });
      expect(await changeRole(dbs.app.db, ctx, w.viewerId, "owner")).toEqual({ ok: false, error: "forbidden" });
      expect(await removeMember(dbs.app.db, ctx, w.viewerId)).toEqual({ ok: false, error: "forbidden" });
      expect(await resetMemberPassword(dbs.app.db, ctx, w.agentId)).toEqual({ ok: false, error: "forbidden" });
    }
  });
});

describe("roles y bajas", () => {
  it("cambiar el rol surte efecto en la siguiente peticion (la sesion lee el rol de la base de datos)", async () => {
    const w = await world();
    const sess = await sessionOf(w, w.agentId);
    expect(await getSessionState(dbs.app.db, sess)).toMatchObject({ ok: true, role: "agent" });
    expect(await changeRole(dbs.app.db, w.owner, w.agentId, "viewer")).toEqual({ ok: true, role: "viewer" });
    expect(await getSessionState(dbs.app.db, sess)).toMatchObject({ ok: true, role: "viewer" });
  });

  it("siempre queda al menos un dueño: no se puede degradar ni dar de baja al ultimo", async () => {
    const w = await world();
    expect(await changeRole(dbs.app.db, w.owner, w.ownerId, "agent")).toEqual({ ok: false, error: "last_owner" });
    expect(await removeMember(dbs.app.db, w.owner, w.ownerId)).toEqual({ ok: false, error: "last_owner" });

    await changeRole(dbs.app.db, w.owner, w.agentId, "owner"); // ahora hay dos
    expect(await changeRole(dbs.app.db, w.owner, w.ownerId, "agent")).toEqual({ ok: true, role: "agent" });
  });

  it("dar de baja quita el acceso de inmediato, aunque la cookie siga vigente", async () => {
    const w = await world();
    const sess = await sessionOf(w, w.agentId);
    expect(await removeMember(dbs.app.db, w.owner, w.agentId)).toEqual({ ok: true });
    expect(await getSessionState(dbs.app.db, sess)).toEqual({ ok: false, reason: "no_membership" });
    expect((await listMembers(dbs.app.db, w.owner)).map((m) => m.userId)).not.toContain(w.agentId);
    expect(await removeMember(dbs.app.db, w.owner, w.agentId)).toEqual({ ok: false, error: "not_found" });
  });

  it("un dueño no administra a los usuarios de otro negocio", async () => {
    const a = await world();
    const b = await world();
    expect(await changeRole(dbs.app.db, b.owner, a.agentId, "owner")).toEqual({ ok: false, error: "not_found" });
    expect(await removeMember(dbs.app.db, b.owner, a.agentId)).toEqual({ ok: false, error: "not_found" });
    expect((await listMembers(dbs.app.db, b.owner)).map((m) => m.userId)).not.toContain(a.agentId);
  });
});

describe("restablecer la contraseña de otra persona", () => {
  it("deja una temporal, obliga a cambiarla y cierra sus sesiones abiertas", async () => {
    const w = await world();
    const sess = await sessionOf(w, w.agentId);
    const r = await resetMemberPassword(dbs.app.db, w.owner, w.agentId);
    expect(r).toMatchObject({ ok: true });
    const temp = (r as { temporaryPassword: string }).temporaryPassword;

    expect((await authenticate(dbs.app.db, await emailOf(w.agentId), PASSWORD)).ok).toBe(false); // la vieja ya no
    const login = await authenticate(dbs.app.db, await emailOf(w.agentId), temp);
    expect(login.ok && login.login.mustChangePassword).toBe(true);
    expect(await getSessionState(dbs.app.db, sess)).toEqual({ ok: false, reason: "revoked" });
  });

  it("no sirve para tu propia cuenta (para eso esta 'cambiar mi contraseña')", async () => {
    const w = await world();
    expect(await resetMemberPassword(dbs.app.db, w.owner, w.ownerId)).toEqual({ ok: false, error: "use_own_password" });
  });

  it("SEGURIDAD: no se puede tocar la cuenta de alguien que tambien esta en OTRO negocio, ni la de un negocio ajeno", async () => {
    const a = await world();
    const b = await world();
    // El usuario 'viewer' de B tambien entra a A.
    await addMember(dbs.app.db, a.owner, { email: await emailOf(b.viewerId), role: "viewer" });
    expect(await resetMemberPassword(dbs.app.db, a.owner, b.viewerId)).toEqual({ ok: false, error: "cannot_reset" });
    expect(await resetMemberPassword(dbs.app.db, b.owner, b.viewerId)).toEqual({ ok: false, error: "cannot_reset" }); // tampoco el de B
    expect((await authenticate(dbs.app.db, await emailOf(b.viewerId), PASSWORD)).ok).toBe(true); // intacta

    // Un usuario que solo esta en A no lo puede restablecer el dueño de B.
    expect(await resetMemberPassword(dbs.app.db, b.owner, a.agentId)).toEqual({ ok: false, error: "cannot_reset" });
    expect((await authenticate(dbs.app.db, await emailOf(a.agentId), PASSWORD)).ok).toBe(true);
  });
});

describe("mi cuenta", () => {
  it("cambiar mi contraseña pide la actual, valida la nueva y cierra las demas sesiones (esta sigue con la nueva version)", async () => {
    const w = await world();
    const before = await sessionOf(w, w.agentId);

    expect(await changeOwnPassword(dbs.app.db, w.agent, "contraseña-equivocada", "Otra-contraseña-2027")).toEqual({ ok: false, error: "wrong_password" });
    expect(await changeOwnPassword(dbs.app.db, w.agent, PASSWORD, "corta")).toMatchObject({ ok: false, error: "weak_password" });
    expect(await changeOwnPassword(dbs.app.db, w.agent, PASSWORD, PASSWORD)).toEqual({ ok: false, error: "same_password" });

    const r = await changeOwnPassword(dbs.app.db, w.agent, PASSWORD, "Nueva-contraseña-2027");
    expect(r).toMatchObject({ ok: true });
    const sv = (r as { sessionVersion: number }).sessionVersion;
    expect(sv).toBe(before.sv + 1);

    const email = await emailOf(w.agentId);
    expect((await authenticate(dbs.app.db, email, PASSWORD)).ok).toBe(false);
    expect((await authenticate(dbs.app.db, email, "Nueva-contraseña-2027")).ok).toBe(true);
    expect(await getSessionState(dbs.app.db, before)).toEqual({ ok: false, reason: "revoked" }); // otras sesiones fuera
    expect(await getSessionState(dbs.app.db, { ...before, sv })).toMatchObject({ ok: true }); // esta sigue
  });

  it("cambiar la contraseña temporal quita la marca de 'debe cambiarla'", async () => {
    const w = await world();
    const r = (await resetMemberPassword(dbs.app.db, w.owner, w.agentId)) as { temporaryPassword: string };
    expect((await userRow(w.agentId)).mustChangePassword).toBe(true);
    await changeOwnPassword(dbs.app.db, w.agent, r.temporaryPassword, "Mi-contraseña-definitiva-1");
    expect((await userRow(w.agentId)).mustChangePassword).toBe(false);
  });

  it("cerrar sesion en todos los dispositivos invalida toda cookie anterior", async () => {
    const w = await world();
    const sess = await sessionOf(w, w.viewerId);
    expect(await getSessionState(dbs.app.db, sess)).toMatchObject({ ok: true });
    await signOutEverywhere(dbs.app.db, w.viewerId);
    expect(await getSessionState(dbs.app.db, sess)).toEqual({ ok: false, reason: "revoked" });
    expect((await authenticate(dbs.app.db, await emailOf(w.viewerId), PASSWORD)).ok).toBe(true); // y puede volver a entrar
  });

  it("el cierre de sesion de uno no afecta a otros usuarios", async () => {
    const w = await world();
    const other = await sessionOf(w, w.ownerId);
    await signOutEverywhere(dbs.app.db, w.viewerId);
    expect(await getSessionState(dbs.app.db, other)).toMatchObject({ ok: true });
  });
});

describe("estado de la sesion", () => {
  it("devuelve rol, nombre y negocio vigentes", async () => {
    const w = await world();
    expect(await getSessionState(dbs.app.db, await sessionOf(w, w.ownerId))).toMatchObject({
      ok: true,
      role: "owner",
      tenantName: "Clínica Panel",
      timezone: "America/Merida",
      mustChangePassword: false,
    });
  });

  it("rechaza una cookie para un negocio al que el usuario no pertenece (no se puede 'saltar' de negocio)", async () => {
    const a = await world();
    const b = await world();
    expect(await getSessionState(dbs.app.db, { uid: a.ownerId, tid: b.tenantId, sv: 0 })).toEqual({ ok: false, reason: "no_membership" });
  });

  it("un negocio pausado deja sin acceso a todos sus usuarios", async () => {
    const w = await world();
    const sess = await sessionOf(w, w.ownerId);
    await dbs.owner.db.update(tenants).set({ status: "paused" }).where(eq(tenants.id, w.tenantId));
    expect(await getSessionState(dbs.app.db, sess)).toEqual({ ok: false, reason: "tenant_inactive" });
  });

  it("una version de sesion adivinada o de otro usuario no sirve", async () => {
    const w = await world();
    expect(await getSessionState(dbs.app.db, { uid: w.ownerId, tid: w.tenantId, sv: 999 })).toEqual({ ok: false, reason: "revoked" });
    expect(await getSessionState(dbs.app.db, { uid: "00000000-0000-4000-8000-000000000000", tid: w.tenantId, sv: 0 })).toEqual({ ok: false, reason: "revoked" });
  });
});

describe("cambiar de negocio", () => {
  it("lista solo los negocios a los que pertenece y solo deja cambiar a esos", async () => {
    const a = await world();
    const b = await world();
    const c = await world();
    await dbs.owner.db.insert(memberships).values({ tenantId: b.tenantId, userId: a.ownerId, role: "viewer" });

    const mine = await listMyTenants(dbs.app.db, a.ownerId);
    expect(mine.map((t) => [t.tenantId, t.role]).sort()).toEqual([[a.tenantId, "owner"], [b.tenantId, "viewer"]].sort());
    expect(await canSwitchTo(dbs.app.db, a.ownerId, b.tenantId)).toMatchObject({ tenantId: b.tenantId, role: "viewer" });
    expect(await canSwitchTo(dbs.app.db, a.ownerId, c.tenantId)).toBeNull();
  });

  it("un negocio pausado no aparece como opcion", async () => {
    const a = await world();
    const b = await world();
    await dbs.owner.db.insert(memberships).values({ tenantId: b.tenantId, userId: a.ownerId, role: "owner" });
    await dbs.owner.db.update(tenants).set({ status: "paused" }).where(eq(tenants.id, b.tenantId));
    expect((await listMyTenants(dbs.app.db, a.ownerId)).map((t) => t.tenantId)).toEqual([a.tenantId]);
  });
});
