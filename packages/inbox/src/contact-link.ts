import { findRelatedContacts, type MatchReason } from "@empleado/agent";
import { appointments, auditLog, calls, contactIdentities, contacts, conversations, channels, orders, reservations, services, staff, withTenant, type Database, type Tx } from "@empleado/db";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { can, fail, type Failure, type PanelContext, type Success } from "./types";

/**
 * Un mismo cliente puede escribir por Facebook, Instagram, WhatsApp o llamar por telefono, y cada red lo
 * identifica distinto. Aqui se muestran las citas de un cliente, se sugieren posibles duplicados y una persona del
 * equipo los UNE (nunca se unen solos: quien escribe por una red puede decir cualquier nombre o telefono).
 */

export interface ContactAppointment {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: "pending" | "confirmed";
  service: string;
  staff: string;
}

export interface PossibleSameContact {
  contactId: string;
  name: string;
  phone: string | null;
  /** Por donde ha hablado con el negocio. */
  channels: string[];
  reason: MatchReason;
  appointments: ContactAppointment[];
}

export interface ContactRelations {
  /** Citas activas y futuras de ESTE cliente. */
  appointments: ContactAppointment[];
  possibleSame: PossibleSameContact[];
}

async function upcomingFor(tx: Tx, contactIds: string[], now: Date): Promise<Map<string, ContactAppointment[]>> {
  const out = new Map<string, ContactAppointment[]>();
  if (contactIds.length === 0) return out;
  const rows = await tx
    .select({ a: appointments, service: services.name, staff: staff.name })
    .from(appointments)
    .innerJoin(services, eq(services.id, appointments.serviceId))
    .innerJoin(staff, eq(staff.id, appointments.staffId))
    .where(and(inArray(appointments.contactId, contactIds), inArray(appointments.status, ["pending", "confirmed"]), gte(appointments.endsAt, now)))
    .orderBy(asc(appointments.startsAt));
  for (const r of rows) {
    const list = out.get(r.a.contactId) ?? [];
    list.push({ id: r.a.id, startsAt: r.a.startsAt, endsAt: r.a.endsAt, status: r.a.status as "pending" | "confirmed", service: r.service, staff: r.staff });
    out.set(r.a.contactId, list);
  }
  return out;
}

/** Los canales por los que ha hablado cada contacto (por conversaciones o identidades). */
async function channelsOf(tx: Tx, contactIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, Set<string>>();
  if (contactIds.length === 0) return new Map();
  const rows = await tx
    .select({ contactId: conversations.contactId, type: channels.type })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(inArray(conversations.contactId, contactIds));
  for (const r of rows) {
    if (r.type === "playground") continue;
    (out.get(r.contactId) ?? out.set(r.contactId, new Set()).get(r.contactId)!).add(r.type);
  }
  return new Map([...out].map(([k, v]) => [k, [...v]]));
}

const label = (c: typeof contacts.$inferSelect) => {
  const p = (c.profile ?? {}) as Record<string, unknown>;
  const nick = [p.whatsapp_name, p.messenger_name, p.instagram_name].find((v) => typeof v === "string");
  return c.displayName ?? (typeof nick === "string" ? nick : null) ?? c.phoneE164 ?? "Cliente";
};

/** Citas del cliente y posibles duplicados (con sus citas). Dentro de una transaccion del negocio. */
export async function contactRelations(tx: Tx, contactId: string, now: Date): Promise<ContactRelations> {
  const [me] = await tx.select().from(contacts).where(eq(contacts.id, contactId));
  if (!me) return { appointments: [], possibleSame: [] };
  const related = await findRelatedContacts(tx, { id: me.id, displayName: me.displayName, phoneE164: me.phoneE164, profile: me.profile });
  const ids = related.map((r) => r.id);
  const [appts, chans, others] = await Promise.all([
    upcomingFor(tx, [me.id, ...ids], now),
    channelsOf(tx, ids),
    ids.length ? tx.select().from(contacts).where(inArray(contacts.id, ids)) : Promise.resolve([]),
  ]);
  const byId = new Map(others.map((c) => [c.id, c]));
  return {
    appointments: appts.get(me.id) ?? [],
    possibleSame: related.flatMap((r): PossibleSameContact[] => {
      const c = byId.get(r.id);
      return c ? [{ contactId: c.id, name: label(c), phone: c.phoneE164, channels: chans.get(c.id) ?? [], reason: r.reason, appointments: appts.get(c.id) ?? [] }] : [];
    }),
  };
}

/** Lo mismo, para la pantalla "Nueva cita" (elige al cliente y ve si ya tiene cita). */
export async function getContactRelations(db: Database, ctx: PanelContext, contactId: string, now = new Date()): Promise<ContactRelations> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, (tx) => contactRelations(tx, contactId, now));
}

export type LinkError = "forbidden" | "not_found" | "same_contact";

/**
 * Une dos contactos que son la misma persona: todo (conversaciones de cualquier red, citas, llamadas, identidades)
 * pasa al contacto que SE CONSERVA y el otro desaparece. Los datos del que se conserva tienen prioridad.
 */
export async function mergeContacts(
  db: Database,
  ctx: PanelContext,
  input: { keepId: string; mergeId: string },
): Promise<Success<{ keptId: string }> | Failure<LinkError>> {
  if (!can(ctx.role, "manage_appointments")) return fail("forbidden");
  if (input.keepId === input.mergeId) return fail("same_contact");

  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [keep] = await tx.select().from(contacts).where(eq(contacts.id, input.keepId));
    const [gone] = await tx.select().from(contacts).where(eq(contacts.id, input.mergeId));
    if (!keep || !gone) return fail("not_found" as const);

    await tx.update(contactIdentities).set({ contactId: keep.id, updatedAt: new Date() }).where(eq(contactIdentities.contactId, gone.id));
    await tx.update(conversations).set({ contactId: keep.id }).where(eq(conversations.contactId, gone.id));
    await tx.update(appointments).set({ contactId: keep.id }).where(eq(appointments.contactId, gone.id));
    await tx.update(calls).set({ contactId: keep.id }).where(eq(calls.contactId, gone.id));
    await tx.update(orders).set({ contactId: keep.id }).where(eq(orders.contactId, gone.id));
    await tx.update(reservations).set({ contactId: keep.id }).where(eq(reservations.contactId, gone.id));

    // Perfil: lo del que se conserva manda; se agrega lo que solo tenia el otro. Las marcas de sugerencias se limpian.
    const keepProfile = { ...((keep.profile ?? {}) as Record<string, unknown>) };
    const goneProfile = { ...((gone.profile ?? {}) as Record<string, unknown>) };
    for (const k of ["no_unir", "telefono_declarado"]) {
      delete keepProfile[k];
      delete goneProfile[k];
    }
    const profile: Record<string, unknown> = { ...goneProfile, ...keepProfile };
    // Dos telefonos distintos: se conserva el principal y el otro queda anotado.
    const extraPhone = keep.phoneE164 && gone.phoneE164 && keep.phoneE164 !== gone.phoneE164 ? gone.phoneE164 : null;
    if (extraPhone) profile.otros_telefonos = [...new Set([...(Array.isArray(profile.otros_telefonos) ? (profile.otros_telefonos as string[]) : []), extraPhone])];

    // El telefono es unico por negocio: se libera del contacto que desaparece antes de pasarlo.
    const phone = keep.phoneE164 ?? gone.phoneE164;
    if (gone.phoneE164) await tx.update(contacts).set({ phoneE164: null }).where(eq(contacts.id, gone.id));

    const optedOutAt = keep.optedOutAt ?? gone.optedOutAt; // quien pidio no recibir mensajes sigue sin recibirlos
    await tx
      .update(contacts)
      .set({
        displayName: keep.displayName ?? gone.displayName,
        email: keep.email ?? gone.email,
        phoneE164: phone,
        tags: [...new Set([...keep.tags, ...gone.tags])],
        profile,
        optedOutAt,
        optInMarketing: !optedOutAt && (keep.optInMarketing || gone.optInMarketing),
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, keep.id));

    await tx.delete(contacts).where(eq(contacts.id, gone.id));
    await tx.insert(auditLog).values({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "contact.merged",
      entity: "contact",
      entityId: keep.id,
      diff: { mergedContactId: gone.id, mergedName: label(gone) },
    });
    return { ok: true as const, keptId: keep.id };
  });
}

/** "No es la misma persona": deja de sugerirse. */
export async function dismissPossibleSame(db: Database, ctx: PanelContext, contactId: string, otherId: string): Promise<Success | Failure<LinkError>> {
  if (!can(ctx.role, "manage_appointments")) return fail("forbidden");
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [me] = await tx.select().from(contacts).where(eq(contacts.id, contactId));
    if (!me) return fail("not_found" as const);
    const profile = { ...((me.profile ?? {}) as Record<string, unknown>) };
    const list = Array.isArray(profile.no_unir) ? (profile.no_unir as string[]) : [];
    profile.no_unir = [...new Set([...list, otherId])].slice(-50);
    await tx.update(contacts).set({ profile, updatedAt: new Date() }).where(eq(contacts.id, me.id));
    return { ok: true as const };
  });
}
