import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, resolveChannel, withTenant, type DbHandle } from "../src/client";
import { loadEnv, requireEnv } from "../src/env";
import * as s from "../src/schema";

loadEnv();

let owner: DbHandle; // propietario: prepara y limpia datos
let app: DbHandle; // rol de la app: el que debe respetar RLS

interface Fixture {
  tenantId: string;
  userId: string;
  serviceId: string;
  staffId: string;
  contactId: string;
  channelId: string;
  externalChannelId: string;
}
let A: Fixture;
let B: Fixture;

async function makeTenant(label: string): Promise<Fixture> {
  const { db } = owner;
  const suffix = randomUUID().slice(0, 8);
  const [t] = await db
    .insert(s.tenants)
    .values({ name: `Test ${label}`, slug: `test-${label}-${suffix}`, vertical: "dental" })
    .returning();
  const tenantId = t!.id;
  const [u] = await db
    .insert(s.users)
    .values({ email: `${label}-${suffix}@test.local` })
    .returning();
  await db.insert(s.memberships).values({ tenantId, userId: u!.id, role: "owner" });
  const [svc] = await db
    .insert(s.services)
    .values({ tenantId, name: `Servicio ${label}`, durationMin: 30 })
    .returning();
  const [st] = await db.insert(s.staff).values({ tenantId, name: `Staff ${label}` }).returning();
  const [c] = await db.insert(s.contacts).values({ tenantId, displayName: `Contacto ${label}` }).returning();
  const externalChannelId = `test-${label}-${suffix}`;
  const [ch] = await db
    .insert(s.channels)
    .values({ tenantId, type: "whatsapp", externalId: externalChannelId })
    .returning();
  return {
    tenantId,
    userId: u!.id,
    serviceId: svc!.id,
    staffId: st!.id,
    contactId: c!.id,
    channelId: ch!.id,
    externalChannelId,
  };
}

beforeAll(async () => {
  owner = createDb(requireEnv("DATABASE_URL"), { max: 2 });
  app = createDb(requireEnv("DATABASE_APP_URL"), { max: 4 });
  A = await makeTenant("a");
  B = await makeTenant("b");
});

afterAll(async () => {
  for (const f of [A, B]) {
    if (!f) continue;
    await owner.db.delete(s.tenants).where(eq(s.tenants.id, f.tenantId));
    await owner.db.delete(s.users).where(eq(s.users.id, f.userId));
  }
  await app?.close();
  await owner?.close();
});

/** Extrae el codigo SQLSTATE del error de postgres, sea cual sea la envoltura de Drizzle. */
async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code;
  }
}

describe("aislamiento por tenant (RLS)", () => {
  it("la app NO es superusuario ni propietaria (si lo fuera, RLS no aplicaria)", async () => {
    const rows = await app.db.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it("sin contexto de tenant no se ve ninguna fila", async () => {
    for (const table of [s.services, s.contacts, s.channels, s.staff, s.tenants]) {
      const rows = await app.db.select().from(table);
      expect(rows, `tabla ${table}`).toHaveLength(0);
    }
  });

  it("cada tenant ve solo lo suyo", async () => {
    const seenByA = await withTenant(app.db, { tenantId: A.tenantId }, (tx) =>
      tx.select().from(s.services),
    );
    const seenByB = await withTenant(app.db, { tenantId: B.tenantId }, (tx) =>
      tx.select().from(s.services),
    );
    expect(seenByA.map((r) => r.id)).toEqual([A.serviceId]);
    expect(seenByB.map((r) => r.id)).toEqual([B.serviceId]);
  });

  it("un tenant no puede leer una fila del otro ni conociendo su id", async () => {
    const rows = await withTenant(app.db, { tenantId: A.tenantId }, (tx) =>
      tx.select().from(s.contacts).where(eq(s.contacts.id, B.contactId)),
    );
    expect(rows).toHaveLength(0);
    const tenants = await withTenant(app.db, { tenantId: A.tenantId }, (tx) =>
      tx.select().from(s.tenants),
    );
    expect(tenants.map((t) => t.id)).toEqual([A.tenantId]);
  });

  it("no se puede insertar con el tenant_id de otro (WITH CHECK)", async () => {
    const code = await sqlState(
      withTenant(app.db, { tenantId: A.tenantId }, (tx) =>
        tx.insert(s.services).values({ tenantId: B.tenantId, name: "Intruso", durationMin: 10 }),
      ),
    );
    expect(code).toBe("42501"); // insufficient_privilege: violacion de la politica RLS
  });

  it("actualizar o borrar filas de otro tenant no afecta a ninguna", async () => {
    const updated = await withTenant(app.db, { tenantId: A.tenantId }, (tx) =>
      tx.update(s.services).set({ name: "Hackeado" }).where(eq(s.services.id, B.serviceId)).returning(),
    );
    const deleted = await withTenant(app.db, { tenantId: A.tenantId }, (tx) =>
      tx.delete(s.services).where(eq(s.services.id, B.serviceId)).returning(),
    );
    expect(updated).toHaveLength(0);
    expect(deleted).toHaveLength(0);
    const [still] = await owner.db.select().from(s.services).where(eq(s.services.id, B.serviceId));
    expect(still?.name).toBe("Servicio b");
  });

  it("el tenant no se arrastra entre peticiones que reusan la conexion", async () => {
    const single = createDb(requireEnv("DATABASE_APP_URL"), { max: 1 });
    try {
      const first = await withTenant(single.db, { tenantId: A.tenantId }, (tx) =>
        tx.select().from(s.services),
      );
      expect(first).toHaveLength(1);
      const second = await single.db.select().from(s.services); // sin contexto, misma conexion
      expect(second).toHaveLength(0);
    } finally {
      await single.close();
    }
  });

  it("un usuario solo es visible dentro de su negocio", async () => {
    const fromA = await withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.select().from(s.users));
    expect(fromA.map((u) => u.id)).toEqual([A.userId]);
  });

  it("TODA tabla con tenant_id tiene RLS activo, forzado y al menos una politica", async () => {
    const rows = await owner.db.execute<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: number;
    }>(sql`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relname in (
          select table_name from information_schema.columns
          where table_schema = 'public' and column_name = 'tenant_id'
        )
    `);
    expect(rows.length).toBeGreaterThanOrEqual(20);
    const unprotected = rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity || r.policies < 1);
    expect(unprotected.map((r) => r.relname)).toEqual([]);
  });

  it("la bitacora es append-only para la app", async () => {
    await withTenant(app.db, { tenantId: A.tenantId }, (tx) =>
      tx.insert(s.auditLog).values({ tenantId: A.tenantId, action: "test", entity: "test" }),
    );
    const code = await sqlState(
      withTenant(app.db, { tenantId: A.tenantId }, (tx) => tx.delete(s.auditLog)),
    );
    expect(code).toBe("42501");
  });
});

describe("resolucion de webhook -> tenant", () => {
  it("resuelve el canal sin contexto previo", async () => {
    const found = await resolveChannel(app.db, "whatsapp", A.externalChannelId);
    expect(found).toEqual({ tenantId: A.tenantId, channelId: A.channelId });
  });

  it("devuelve null para un id desconocido", async () => {
    expect(await resolveChannel(app.db, "whatsapp", "no-existe")).toBeNull();
  });

  it("no permite dos canales con el mismo phone_number_id, ni en otro tenant", async () => {
    const code = await sqlState(
      owner.db.insert(s.channels).values({
        tenantId: B.tenantId,
        type: "whatsapp",
        externalId: A.externalChannelId,
      }),
    );
    expect(code).toBe("23505"); // unique_violation
  });
});

describe("idempotencia de mensajes", () => {
  it("el mismo wamid en el mismo canal no se guarda dos veces", async () => {
    const [conv] = await owner.db
      .insert(s.conversations)
      .values({ tenantId: A.tenantId, contactId: A.contactId, channelId: A.channelId })
      .returning();
    const msg = {
      tenantId: A.tenantId,
      conversationId: conv!.id,
      channelId: A.channelId,
      direction: "in" as const,
      sender: "contact" as const,
      body: "Hola",
      externalId: "wamid.TEST123",
    };
    await owner.db.insert(s.messages).values(msg);
    const code = await sqlState(owner.db.insert(s.messages).values(msg));
    expect(code).toBe("23505");
  });
});

describe("citas", () => {
  const at = (h: number, m = 0) => new Date(Date.UTC(2027, 2, 2, h, m));
  const appt = (startH: number, endH: number, status: "confirmed" | "cancelled" = "confirmed") => ({
    tenantId: A.tenantId,
    contactId: A.contactId,
    serviceId: A.serviceId,
    staffId: A.staffId,
    startsAt: at(startH),
    endsAt: at(endH),
    status,
  });

  it("bloquea dos citas activas traslapadas del mismo empleado", async () => {
    await owner.db.insert(s.appointments).values(appt(15, 16));
    const code = await sqlState(owner.db.insert(s.appointments).values(appt(15, 17)));
    expect(code).toBe("23P01"); // exclusion_violation
  });

  it("permite citas contiguas y reusar un hueco cancelado", async () => {
    await owner.db.insert(s.appointments).values(appt(16, 17)); // contigua a 15-16
    await owner.db.insert(s.appointments).values(appt(15, 16, "cancelled")); // el hueco 15-16 ya esta ocupado, pero esta cancelada
  });

  it("rechaza una cita que termina antes de empezar", async () => {
    const code = await sqlState(owner.db.insert(s.appointments).values(appt(20, 19)));
    expect(code).toBe("23514"); // check_violation
  });
});
