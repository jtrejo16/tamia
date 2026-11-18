import { appointments, auditLog, channels, contactIdentities, contacts, conversations } from "@empleado/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dismissPossibleSame, getContactRelations, getConversation, mergeContacts } from "../src";
import { NOW, dropWorld, makeWorld, openDbs, type Dbs, type World } from "./helpers";

let dbs: Dbs;
const worlds: World[] = [];
beforeAll(() => {
  dbs = openDbs();
});
afterAll(async () => {
  for (const w of worlds) await dropWorld(dbs.owner, w);
  await dbs.app.close();
  await dbs.owner.close();
});

/** Un negocio con un cliente de WhatsApp ("Carlos Pérez") y, aparte, el mismo nombre escribiendo por Messenger con una cita. */
async function scenario() {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  const { db } = dbs.owner;
  const [page] = await db.insert(channels).values({ tenantId: w.tenantId, type: "messenger", externalId: `page-${w.tenantId.slice(0, 8)}` }).returning();
  const [fb] = await db.insert(contacts).values({ tenantId: w.tenantId, displayName: "carlos perez", profile: { messenger_name: "Carlitos FB", alergia: "penicilina" }, tags: ["fb"] }).returning();
  await db.insert(contactIdentities).values({ tenantId: w.tenantId, contactId: fb!.id, channelType: "messenger", channelId: page!.id, externalId: `psid-${fb!.id.slice(0, 8)}` });
  const [fbConv] = await db.insert(conversations).values({ tenantId: w.tenantId, contactId: fb!.id, channelId: page!.id, lastInboundAt: NOW, lastMessageAt: NOW }).returning();
  const [appt] = await db
    .insert(appointments)
    .values({ tenantId: w.tenantId, contactId: fb!.id, serviceId: w.serviceId, staffId: w.staffId, startsAt: new Date("2027-03-03T16:00:00Z"), endsAt: new Date("2027-03-03T16:45:00Z"), status: "confirmed" })
    .returning();
  return { w, fbId: fb!.id, fbConvId: fbConv!.id, apptId: appt!.id };
}

describe("el mismo cliente por varios medios", () => {
  it("la conversacion muestra las citas del cliente y sugiere al posible mismo cliente de otra red con su cita", async () => {
    const { w, fbId, fbConvId, apptId } = await scenario();

    // Desde WhatsApp: no tiene cita propia, pero hay un posible duplicado (Messenger) que SI tiene.
    const wa = await getConversation(dbs.app.db, w.agent, w.conversationId, { now: NOW });
    expect(wa!.relations.appointments).toHaveLength(0);
    expect(wa!.relations.possibleSame).toHaveLength(1);
    expect(wa!.relations.possibleSame[0]).toMatchObject({ contactId: fbId, reason: "name", channels: ["messenger"] });
    expect(wa!.relations.possibleSame[0]!.appointments.map((a) => a.id)).toEqual([apptId]);

    // Desde Messenger: tiene su cita, y sugiere al de WhatsApp.
    const fb = await getConversation(dbs.app.db, w.agent, fbConvId, { now: NOW });
    expect(fb!.relations.appointments.map((a) => a.id)).toEqual([apptId]);
    expect(fb!.relations.possibleSame.map((p) => p.contactId)).toEqual([w.contactId]);
  });

  it("no sugiere por un nombre de una sola palabra, ni a gente de otro negocio, ni citas canceladas o pasadas", async () => {
    const { w, apptId } = await scenario();
    const other = await scenario(); // otro negocio con el mismo nombre
    const rel = await getContactRelations(dbs.app.db, w.agent, w.contactId, NOW);
    expect(rel.possibleSame.every((p) => p.contactId !== other.fbId)).toBe(true);

    await dbs.owner.db.update(appointments).set({ status: "cancelled" }).where(eq(appointments.id, apptId));
    const after = await getContactRelations(dbs.app.db, w.agent, w.contactId, NOW);
    expect(after.possibleSame[0]!.appointments).toEqual([]);

    await dbs.owner.db.update(contacts).set({ displayName: "Carlos" }).where(eq(contacts.id, w.contactId));
    expect((await getContactRelations(dbs.app.db, w.agent, w.contactId, NOW)).possibleSame).toEqual([]);
  });

  it("sugiere por telefono (con o sin el 1 de WhatsApp) y por el telefono que el cliente dijo tener", async () => {
    const w = await makeWorld(dbs.owner);
    worlds.push(w);
    const { db } = dbs.owner;
    await db.update(contacts).set({ phoneE164: "+5219991112233", displayName: null }).where(eq(contacts.id, w.contactId));
    const [voice] = await db.insert(contacts).values({ tenantId: w.tenantId, phoneE164: "+529991112233" }).returning();
    expect((await getContactRelations(dbs.app.db, w.agent, w.contactId, NOW)).possibleSame).toMatchObject([{ contactId: voice!.id, reason: "phone" }]);

    const [fb] = await db.insert(contacts).values({ tenantId: w.tenantId, profile: { telefono_declarado: "+5219991112233" } }).returning();
    const rel = await getContactRelations(dbs.app.db, w.agent, fb!.id, NOW);
    expect(rel.possibleSame.map((p) => p.reason)).toContain("declared_phone");
  });

  it("'no es la misma persona' deja de sugerirlo", async () => {
    const { w, fbId } = await scenario();
    expect(await dismissPossibleSame(dbs.app.db, w.agent, w.contactId, fbId)).toEqual({ ok: true });
    expect((await getContactRelations(dbs.app.db, w.agent, w.contactId, NOW)).possibleSame).toEqual([]);
    // Y un lector no puede.
    expect(await dismissPossibleSame(dbs.app.db, w.viewer, w.contactId, fbId)).toEqual({ ok: false, error: "forbidden" });
  });

  it("unir pasa conversaciones, citas e identidades al contacto que se conserva y no pierde datos", async () => {
    const { w, fbId, fbConvId, apptId } = await scenario();
    await dbs.owner.db.update(contacts).set({ email: "carlos@x.mx", optedOutAt: NOW }).where(eq(contacts.id, fbId));

    const r = await mergeContacts(dbs.app.db, w.agent, { keepId: w.contactId, mergeId: fbId });
    expect(r).toEqual({ ok: true, keptId: w.contactId });

    const { db } = dbs.owner;
    expect(await db.select().from(contacts).where(eq(contacts.id, fbId))).toHaveLength(0);
    const [appt] = await db.select().from(appointments).where(eq(appointments.id, apptId));
    expect(appt!.contactId).toBe(w.contactId);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, fbConvId));
    expect(conv!.contactId).toBe(w.contactId);
    expect(await db.select().from(contactIdentities).where(eq(contactIdentities.contactId, w.contactId))).toHaveLength(1);

    const [kept] = await db.select().from(contacts).where(eq(contacts.id, w.contactId));
    expect(kept).toMatchObject({ displayName: "Carlos Pérez", email: "carlos@x.mx" }); // lo del que se conserva manda; se agrega lo que faltaba
    expect(kept!.profile).toMatchObject({ whatsapp_name: "Carlitos", messenger_name: "Carlitos FB", alergia: "penicilina" });
    expect(kept!.tags).toContain("fb");
    expect(kept!.optedOutAt).not.toBeNull(); // quien pidio no recibir mensajes sigue sin recibirlos
    expect(kept!.optInMarketing).toBe(false);

    const [log] = await db.select().from(auditLog).where(and(eq(auditLog.entityId, w.contactId), eq(auditLog.action, "contact.merged")));
    expect(log).toMatchObject({ userId: w.agentId });

    // Ya es un solo cliente: la conversacion de WhatsApp ve la cita y no hay sugerencias.
    const wa = await getConversation(dbs.app.db, w.agent, w.conversationId, { now: NOW });
    expect(wa!.relations.appointments.map((a) => a.id)).toEqual([apptId]);
    expect(wa!.relations.possibleSame).toEqual([]);
  });

  it("al unir con dos telefonos distintos conserva el principal y anota el otro; sin telefono hereda el del otro", async () => {
    const w = await makeWorld(dbs.owner);
    worlds.push(w);
    const { db } = dbs.owner;
    const [a] = await db.insert(contacts).values({ tenantId: w.tenantId, displayName: "Ana Ruiz", phoneE164: "+529991110001" }).returning();
    const [b] = await db.insert(contacts).values({ tenantId: w.tenantId, displayName: "Ana R.", phoneE164: "+529991110002" }).returning();
    await mergeContacts(dbs.app.db, w.agent, { keepId: a!.id, mergeId: b!.id });
    const [kept] = await db.select().from(contacts).where(eq(contacts.id, a!.id));
    expect(kept).toMatchObject({ phoneE164: "+529991110001" });
    expect(kept!.profile).toMatchObject({ otros_telefonos: ["+529991110002"] });

    const [c] = await db.insert(contacts).values({ tenantId: w.tenantId }).returning(); // sin telefono (Instagram)
    const [d] = await db.insert(contacts).values({ tenantId: w.tenantId, phoneE164: "+529991110003" }).returning();
    await mergeContacts(dbs.app.db, w.agent, { keepId: c!.id, mergeId: d!.id });
    const [kept2] = await db.select().from(contacts).where(eq(contacts.id, c!.id));
    expect(kept2!.phoneE164).toBe("+529991110003");
  });

  it("unir exige permiso, dos clientes distintos y que ambos sean del propio negocio", async () => {
    const { w, fbId } = await scenario();
    const other = await scenario();
    expect(await mergeContacts(dbs.app.db, w.viewer, { keepId: w.contactId, mergeId: fbId })).toEqual({ ok: false, error: "forbidden" });
    expect(await mergeContacts(dbs.app.db, w.agent, { keepId: w.contactId, mergeId: w.contactId })).toEqual({ ok: false, error: "same_contact" });
    expect(await mergeContacts(dbs.app.db, w.agent, { keepId: w.contactId, mergeId: other.fbId })).toEqual({ ok: false, error: "not_found" });
    // Nada cambio en el otro negocio.
    expect(await dbs.owner.db.select().from(contacts).where(eq(contacts.id, other.fbId))).toHaveLength(1);
  });
});
