import {
  bookAppointmentManually,
  formatLocal,
  listFreeSlots,
  type ManualBookingError,
  type ManualSlot,
} from "@empleado/agent";
import { contacts, services, staff, staffServices, tenants, withTenant, type Database } from "@empleado/db";
import { asc, eq, ilike, or, sql } from "drizzle-orm";
import { sendHumanMessage, type SendError } from "./conversations";
import { can, fail, type EnqueueOutbound, type Failure, type PanelContext, type Success } from "./types";

/** Agendar una cita a mano desde el panel (cuando el asistente escalo o el cliente llamo/escribio a la recepcion). */

export type BookingError = "forbidden" | "invalid" | ManualBookingError;

export interface BookingCatalog {
  services: Array<{ id: string; name: string; durationMin: number; staff: Array<{ id: string; name: string }> }>;
}

/** Servicios activos con los especialistas que los atienden. */
export async function bookingCatalog(db: Database, ctx: PanelContext): Promise<BookingCatalog> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const svc = await tx.select().from(services).where(eq(services.active, true)).orderBy(asc(services.name));
    const links = await tx
      .select({ serviceId: staffServices.serviceId, id: staff.id, name: staff.name })
      .from(staffServices)
      .innerJoin(staff, eq(staff.id, staffServices.staffId))
      .where(eq(staff.active, true))
      .orderBy(asc(staff.name));
    return {
      services: svc.map((s) => ({
        id: s.id,
        name: s.name,
        durationMin: s.durationMin,
        staff: links.filter((l) => l.serviceId === s.id).map((l) => ({ id: l.id, name: l.name })),
      })),
    };
  });
}

export interface BookingContact {
  id: string;
  name: string;
  phone: string | null;
}

/** Busca clientes por nombre o telefono para elegir a quien agendar. */
export async function searchBookingContacts(db: Database, ctx: PanelContext, query: string): Promise<BookingContact[]> {
  const q = query.trim().slice(0, 60);
  if (q.length < 2) return [];
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const digits = q.replace(/\D/g, "");
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const rows = await tx
      .select()
      .from(contacts)
      .where(
        or(
          ilike(contacts.displayName, like),
          sql`${contacts.profile}->>'whatsapp_name' ilike ${like}`,
          digits.length >= 4 ? ilike(contacts.phoneE164, `%${digits}%`) : undefined,
        ),
      )
      .orderBy(asc(contacts.displayName))
      .limit(8);
    return rows.map((c) => {
      const wa = ((c.profile ?? {}) as Record<string, unknown>).whatsapp_name;
      return { id: c.id, name: c.displayName ?? (typeof wa === "string" ? wa : null) ?? c.phoneE164 ?? "Cliente", phone: c.phoneE164 };
    });
  });
}

/** Horarios libres de un servicio (todos los de los dias pedidos). */
export async function freeSlots(
  db: Database,
  ctx: PanelContext,
  input: { serviceId: string; staffId?: string; day: string; days?: number },
): Promise<Success<{ timezone: string; service: { id: string; name: string; durationMin: number }; slots: ManualSlot[] }> | Failure<BookingError>> {
  if (!can(ctx.role, "manage_appointments")) return fail("forbidden");
  const r = await listFreeSlots(db, ctx.tenantId, { serviceId: input.serviceId, staffId: input.staffId, fromDay: input.day, days: input.days ?? 1 });
  return r.ok ? { ok: true, timezone: r.timezone, service: r.service, slots: r.slots } : fail(r.error);
}

export type ManualBookingResult = {
  appointmentId: string;
  startsAt: Date;
  endsAt: Date;
  summary: string;
  /** Si se pidio avisar al cliente: true = mensaje en cola; si no se pudo, el motivo. */
  notified: boolean | SendError;
};

/**
 * Agenda la cita (confirmada) a nombre del cliente. Con `notify` y una conversacion, ademas le escribe al cliente
 * el resumen (solo si quien agenda tiene el control de esa conversacion y la ventana de 24 h sigue abierta).
 */
export async function createManualAppointment(
  db: Database,
  ctx: PanelContext,
  input: { contactId: string; serviceId: string; staffId: string; startIso: string; conversationId?: string; notify?: boolean },
  enqueue: EnqueueOutbound,
  now: Date = new Date(),
): Promise<Success<ManualBookingResult> | Failure<BookingError>> {
  if (!can(ctx.role, "manage_appointments")) return fail("forbidden");
  const r = await bookAppointmentManually(db, {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    contactId: input.contactId,
    serviceId: input.serviceId,
    staffId: input.staffId,
    startIso: input.startIso,
    sourceConversationId: input.conversationId ?? null,
    now,
  });
  if (!r.ok) return fail(r.error);

  const timezone = await withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [t] = await tx.select({ tz: tenants.timezone }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    return t?.tz ?? "America/Merida";
  });
  const summary = `Tu cita de ${r.service.name}${r.staffName ? ` con ${r.staffName}` : ""} quedó agendada para ${formatLocal(r.startsAt, timezone)} (${r.service.durationMin} min).`;

  let notified: ManualBookingResult["notified"] = false;
  if (input.notify && input.conversationId) {
    const sent = await sendHumanMessage(db, ctx, input.conversationId, summary, enqueue, now);
    notified = sent.ok ? true : sent.error;
  }
  return { ok: true, appointmentId: r.appointmentId, startsAt: r.startsAt, endsAt: r.endsAt, summary, notified };
}
