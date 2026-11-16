import {
  appointments,
  auditLog,
  contacts,
  services,
  staff,
  tenants,
  withTenant,
  type Database,
} from "@empleado/db";
import { addDays, localDate, zonedTimeToUtc } from "@empleado/scheduling";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import type { ContactSummary } from "./conversations";
import { can, fail, type Failure, type PanelContext, type Success } from "./types";

export interface AppointmentView {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: "pending" | "confirmed" | "cancelled" | "no_show" | "done";
  confirmedByContact: boolean;
  service: { id: string; name: string; durationMin: number };
  staff: { id: string; name: string };
  contact: ContactSummary;
}

export async function listAppointments(
  db: Database,
  ctx: PanelContext,
  options: { from?: Date; to?: Date; includeInactive?: boolean; limit?: number; now?: Date } = {},
): Promise<AppointmentView[]> {
  const now = options.now ?? new Date();
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    // Por defecto: desde el inicio de HOY en la zona horaria del negocio, 30 dias.
    const [tenant] = await tx.select({ tz: tenants.timezone }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const tz = tenant?.tz ?? "America/Merida";
    const today = localDate(now, tz);
    const from = options.from ?? zonedTimeToUtc(today, 0, tz);
    const to = options.to ?? zonedTimeToUtc(addDays(today, 30), 0, tz);

    const rows = await tx
      .select({ a: appointments, service: services, staff: staff, contact: contacts })
      .from(appointments)
      .innerJoin(services, eq(services.id, appointments.serviceId))
      .innerJoin(staff, eq(staff.id, appointments.staffId))
      .innerJoin(contacts, eq(contacts.id, appointments.contactId))
      .where(
        and(
          gte(appointments.startsAt, from),
          lt(appointments.startsAt, to),
          options.includeInactive ? undefined : inArray(appointments.status, ["pending", "confirmed"]),
        ),
      )
      .orderBy(asc(appointments.startsAt))
      .limit(Math.min(options.limit ?? 200, 500));

    return rows.map(({ a, service, staff: member, contact }): AppointmentView => {
      const wa = ((contact.profile ?? {}) as Record<string, unknown>).whatsapp_name;
      return {
        id: a.id,
        startsAt: a.startsAt,
        endsAt: a.endsAt,
        status: a.status,
        confirmedByContact: a.confirmedByContact,
        service: { id: service.id, name: service.name, durationMin: service.durationMin },
        staff: { id: member.id, name: member.name },
        contact: {
          id: contact.id,
          name: contact.displayName ?? (typeof wa === "string" ? wa : null) ?? contact.phoneE164 ?? "Cliente",
          hasRealName: Boolean(contact.displayName),
          whatsappName: typeof wa === "string" ? wa : null,
          phone: contact.phoneE164,
        },
      };
    });
  });
}

export type AppointmentChange = "confirmed" | "cancelled" | "done" | "no_show";
export type ChangeError = "forbidden" | "not_found" | "invalid_transition" | "slot_taken";

const ALLOWED: Record<string, AppointmentChange[]> = {
  pending: ["confirmed", "cancelled", "done", "no_show"],
  confirmed: ["cancelled", "done", "no_show"],
};

/**
 * Cambia el estado de una cita desde el panel. Cancelar aqui NO avisa al cliente por
 * WhatsApp: quien cancela debe escribirle (o usar el asistente).
 */
export async function setAppointmentStatus(
  db: Database,
  ctx: PanelContext,
  appointmentId: string,
  next: AppointmentChange,
): Promise<Success<{ status: AppointmentChange }> | Failure<ChangeError>> {
  if (!can(ctx.role, "manage_appointments")) return fail("forbidden");
  try {
    return await withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
      const [row] = await tx.select().from(appointments).where(eq(appointments.id, appointmentId));
      if (!row) return fail("not_found" as const);
      if (!(ALLOWED[row.status] ?? []).includes(next)) return fail("invalid_transition" as const);
      await tx
        .update(appointments)
        .set({ status: next, updatedAt: new Date(), ...(next === "confirmed" ? { confirmedByContact: false } : {}) })
        .where(eq(appointments.id, appointmentId));
      await tx.insert(auditLog).values({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: `appointment.${next}`,
        entity: "appointment",
        entityId: appointmentId,
        diff: { from: row.status, to: next, actor: "panel" },
      });
      return { ok: true as const, status: next };
    });
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code === "23P01") return fail("slot_taken");
    throw error;
  }
}
