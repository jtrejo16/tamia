import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentConfigs, auditLog, tenants, users } from "@empleado/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operatorChangeVertical } from "../src";
import { dropWorld, makeWorld, openDbs, type Dbs, type World } from "./helpers";

let dbs: Dbs;
const worlds: World[] = [];
beforeAll(async () => {
  dbs = openDbs();
  // La funcion de la migracion 0025, tal como esta en el archivo (si la base ya tenia una version anterior, se reemplaza).
  const file = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../db/migrations/0025_operator_set_vertical.sql"), "utf8");
  const statements = file.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  await dbs.owner.db.execute(sql.raw("DROP FUNCTION IF EXISTS operator_set_vertical(uuid, text)"));
  for (const s of statements) await dbs.owner.db.execute(sql.raw(s));
});
afterAll(async () => {
  for (const w of worlds) await dropWorld(dbs.owner, w);
  await dbs.app.close();
  await dbs.owner.close();
});

async function world() {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  return w;
}
async function operator() {
  const w = await world();
  await dbs.owner.db.update(users).set({ isOperator: true }).where(eq(users.id, w.ownerId));
  return w;
}
const state = async (tenantId: string) => ({
  vertical: (await dbs.owner.db.select().from(tenants).where(eq(tenants.id, tenantId)))[0]!.vertical,
  pack: (await dbs.owner.db.select().from(agentConfigs).where(eq(agentConfigs.tenantId, tenantId)))[0]!,
});
const logs = (tenantId: string) =>
  dbs.owner.db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, "operator.set_vertical")));

describe("operador: cambiar el giro de un negocio", () => {
  it("solo un operador; un dueño de negocio no puede cambiar ni el suyo", async () => {
    const target = await world();
    expect(await operatorChangeVertical(dbs.app.db, target.ownerId, target.tenantId, "belleza")).toEqual({ ok: false, error: "forbidden" });
    expect((await state(target.tenantId)).vertical).toBe("dental");
  });

  it("cambia el giro Y el pack del asistente juntos, y deja constancia en la bitacora", async () => {
    const op = await operator();
    const target = await world();
    const r = await operatorChangeVertical(dbs.app.db, op.ownerId, target.tenantId, "belleza");
    expect(r).toEqual({ ok: true, previous: "dental", changed: true, starterApplied: false, privacyChanged: true }); // dental es de salud: la politica de datos se afloja

    const s = await state(target.tenantId);
    expect(s.vertical).toBe("belleza");
    expect(s.pack).toMatchObject({ packSlug: "belleza", packVersion: "0.1.0" });
    const [log] = await logs(target.tenantId);
    expect(log!.diff).toEqual({ from: "dental", to: "belleza" });
    expect(log!.userId).toBe(op.ownerId);

    // Entre giros sin restriccion no cambia la politica de datos.
    expect(await operatorChangeVertical(dbs.app.db, op.ownerId, target.tenantId, "mascotas")).toEqual({ ok: true, previous: "belleza", changed: true, starterApplied: false, privacyChanged: false });
    // Y hacia uno de salud, se restringe de nuevo.
    expect(await operatorChangeVertical(dbs.app.db, op.ownerId, target.tenantId, "salud")).toMatchObject({ changed: true, privacyChanged: true });
  });

  it("el mismo giro no hace nada ni deja registro", async () => {
    const op = await operator();
    const target = await world();
    expect(await operatorChangeVertical(dbs.app.db, op.ownerId, target.tenantId, "dental")).toEqual({ ok: true, previous: "dental", changed: false, starterApplied: false, privacyChanged: false });
    expect(await logs(target.tenantId)).toHaveLength(0);
  });

  it("rechaza giros que no existen, valores raros y negocios inexistentes; no toca nada", async () => {
    const op = await operator();
    const target = await world();
    for (const bad of ["inventado", "", "DENTAL", "belleza; drop table tenants", 7, null, undefined, ["belleza"]]) {
      expect(await operatorChangeVertical(dbs.app.db, op.ownerId, target.tenantId, bad)).toEqual({ ok: false, error: "invalid" });
    }
    expect(await operatorChangeVertical(dbs.app.db, op.ownerId, "00000000-0000-0000-0000-000000000000", "belleza")).toEqual({ ok: false, error: "not_found" });
    expect((await state(target.tenantId)).vertical).toBe("dental");
    expect(await logs(target.tenantId)).toHaveLength(0);
  });

  it("cambia el de un negocio sin tocar los demas", async () => {
    const op = await operator();
    const a = await world();
    const b = await world();
    await operatorChangeVertical(dbs.app.db, op.ownerId, a.tenantId, "automotriz");
    expect((await state(a.tenantId)).vertical).toBe("automotriz");
    expect((await state(b.tenantId)).vertical).toBe("dental");
    expect((await state(b.tenantId)).pack.packSlug).toBe("dental");
  });
});
