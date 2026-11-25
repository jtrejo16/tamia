import { OCCUPYING, formatWhen, loadReservationEnv, parseDateKey, peakSeats, reserveSeats } from "@empleado/agent";
import {
  auditLog,
  businessHours,
  loadRestaurantSettings,
  reservations,
  restaurantSettings,
  tenants,
  withTenant,
  type Database,
  type ReservationStatus,
  type RestaurantSettingsRow,
} from "@empleado/db";
import { addDays, dateKey, localDate, zonedTimeToUtc } from "@empleado/scheduling";
import { and, asc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { createCustomer } from "./customers";
import { sendCustomerNotice, type NoticeResult } from "./notices";
import { restaurantGate } from "./orders";
import { can, fail, type EnqueueOutbound, type Failure, type PanelContext, type Success } from "./types";

/**
 * Reservaciones de mesa (modulo "restaurante"): la agenda del dia del equipo. Ver lo puede todo rol; cambiar estados, crear a mano
 * y los ajustes, el dueno y la recepcion. Las reservaciones las crea el asistente (por aforo) o alguien del equipo desde el panel.
 */

export type ReservationError = "forbidden" | "module_off" | "not_found" | "invalid_transition" | "invalid" | "sin_cupo";

const scope = (ctx: PanelContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

// ------------------------------------------------------------------------------------------- leer

export interface ReservationView {
  id: string;
  number: number;
  status: ReservationStatus;
  channel: string;
  conversationId: string | null;
  customerName: string;
  customerPhone: string | null;
  partySize: number;
  startsAt: string;
  endsAt: string;
  notes: string | null;
  cancelReason: string | null;
  cancelledBy: string | null;
  createdBy: string;
}

export interface DayView {
  /** AAAA-MM-DD en la hora local del negocio. */
  date: string;
  timeZone: string;
  reservations: ReservationView[];
  /** Comensales con reservacion confirmada o sentada ese dia. */
  covers: number;
  count: number;
  /** Maximo de comensales a la vez ese dia (contra el aforo). */
  peak: number;
  capacity: number;
  enabled: boolean;
}

const toView = (r: typeof reservations.$inferSelect): ReservationView => ({
  id: r.id,
  number: r.number,
  status: r.status,
  channel: r.channel,
  conversationId: r.conversationId,
  customerName: r.customerName,
  customerPhone: r.customerPhone,
  partySize: r.partySize,
  startsAt: r.startsAt.toISOString(),
  endsAt: r.endsAt.toISOString(),
  notes: r.notes,
  cancelReason: r.cancelReason,
  cancelledBy: r.cancelledBy,
  createdBy: r.createdBy,
});

/** Las reservaciones de un dia (por defecto hoy), con los comensales y el pico contra el aforo. */
export async function listReservations(db: Database, ctx: PanelContext, input: { date?: string; now?: Date } = {}): Promise<Success<DayView> | Failure<"module_off" | "invalid">> {
  const now = input.now ?? new Date();
  return withTenant(db, scope(ctx), async (tx) => {
    if (await restaurantGate(tx, ctx, false)) return fail("module_off" as const);
    const [t] = await tx.select({ tz: tenants.timezone }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const timeZone = t?.tz ?? "America/Merida";
    const day = input.date ? parseDateKey(input.date) : localDate(now, timeZone);
    if (!day) return fail("invalid" as const);
    const from = zonedTimeToUtc(day, 0, timeZone);
    const to = zonedTimeToUtc(addDays(day, 1), 0, timeZone);
    const rows = await tx.select().from(reservations).where(and(gte(reservations.startsAt, from), lt(reservations.startsAt, to))).orderBy(asc(reservations.startsAt), asc(reservations.number));
    const settings = await loadRestaurantSettings(tx);
    const active = rows.filter((r) => (OCCUPYING as readonly string[]).includes(r.status));
    return {
      ok: true as const,
      date: dateKey(day),
      timeZone,
      reservations: rows.map(toView),
      covers: active.reduce((s, r) => s + r.partySize, 0),
      count: active.length,
      peak: peakSeats(active, from, to),
      capacity: settings.reservationsCapacity,
      enabled: settings.reservationsEnabled,
    };
  });
}

/** Reservaciones de hoy que aun no llegan (para la insignia del menu). */
export async function countUpcomingReservationsToday(db: Database, ctx: PanelContext, now: Date = new Date()): Promise<number> {
  return withTenant(db, scope(ctx), async (tx) => {
    const [t] = await tx.select({ tz: tenants.timezone }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const tz = t?.tz ?? "America/Merida";
    const end = zonedTimeToUtc(addDays(localDate(now, tz), 1), 0, tz);
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(reservations)
      .where(and(eq(reservations.status, "confirmed"), gte(reservations.startsAt, new Date(now.getTime() - 30 * 60_000)), lt(reservations.startsAt, end)));
    return Number(row?.n ?? 0);
  });
}

// --------------------------------------------------------------------------------------- estados

/** confirmada → sentada → completada; o cancelada / no llego desde confirmada. */
function nextStates(status: ReservationStatus): ReservationStatus[] {
  return status === "confirmed" ? ["seated", "completed", "no_show", "cancelled"] : status === "seated" ? ["completed"] : [];
}

export async function setReservationStatus(
  db: Database,
  ctx: PanelContext,
  id: string,
  to: ReservationStatus,
  input: { reason?: string },
  enqueue: EnqueueOutbound,
  now: Date = new Date(),
): Promise<Success<{ status: ReservationStatus; notice: NoticeResult }> | Failure<ReservationError>> {
  const reason = input.reason?.trim().slice(0, 200) || null;
  const outcome = await withTenant(db, scope(ctx), async (tx) => {
    const denied = await restaurantGate(tx, ctx, true);
    if (denied) return denied;
    const [row] = await tx.select().from(reservations).where(eq(reservations.id, id));
    if (!row) return fail("not_found" as const);
    if (!nextStates(row.status).includes(to)) return fail("invalid_transition" as const);
    if (to === "no_show" && row.startsAt.getTime() > now.getTime()) return fail("invalid_transition" as const); // no puede "no llegar" antes de su hora

    const patch: Partial<typeof reservations.$inferInsert> = { status: to, updatedAt: now };
    if (to === "seated") patch.seatedAt = now;
    if (to === "completed" && !row.seatedAt) patch.seatedAt = now;
    if (to === "cancelled") {
      patch.cancelledAt = now;
      patch.cancelledBy = "equipo";
      patch.cancelReason = reason ?? "Cancelada por el restaurante";
    }
    // Solo si sigue en el estado que vimos: dos personas pueden tocar la misma reservacion a la vez.
    const changed = await tx.update(reservations).set(patch).where(and(eq(reservations.id, id), eq(reservations.status, row.status))).returning({ id: reservations.id });
    if (changed.length === 0) return fail("invalid_transition" as const);
    await tx.insert(auditLog).values({ tenantId: ctx.tenantId, userId: ctx.userId, action: "reservation.status", entity: "reservation", entityId: id, diff: { number: row.number, from: row.status, to } });

    let notice: NoticeResult = "not_needed";
    let messageId: string | null = null;
    if (to === "cancelled") {
      const [t] = await tx.select({ tz: tenants.timezone }).from(tenants).where(eq(tenants.id, ctx.tenantId));
      const text = `Tu reservación #${row.number} para ${row.partySize} ${row.partySize === 1 ? "persona" : "personas"} el ${formatWhen(row.startsAt, t?.tz ?? "America/Merida")} fue cancelada por el restaurante${reason ? `: ${reason}` : ""}. Disculpa las molestias; si quieres, escríbenos y buscamos otra hora.`;
      const sent = await sendCustomerNotice(tx, { tenantId: ctx.tenantId, contactId: row.contactId, conversationId: row.conversationId, text, now });
      notice = sent.notice;
      messageId = sent.messageId;
    }
    return { ok: true as const, status: to, notice, messageId };
  });
  if (!outcome.ok) return outcome;
  if (outcome.messageId) await enqueue({ tenantId: ctx.tenantId, messageId: outcome.messageId }).catch(() => {});
  return { ok: true, status: outcome.status, notice: outcome.notice };
}

// ------------------------------------------------------------------------------------- alta manual

export type ManualInvalid = Failure<"invalid"> & { details: string[] };

/**
 * Alguien del equipo anota una reservacion (por ejemplo, la que pidieron por telefono directo al local). Busca al cliente por
 * su telefono o lo da de alta. Respeta el aforo; con `ignoreCapacity` se reserva aunque pase (queda avisado en el resultado).
 */
export async function createManualReservation(
  db: Database,
  ctx: PanelContext,
  input: { name?: unknown; phone?: unknown; date?: unknown; time?: unknown; partySize?: unknown; notes?: unknown; ignoreCapacity?: unknown },
  now: Date = new Date(),
): Promise<Success<{ reservation: ReservationView; overbooked: boolean }> | Failure<"forbidden" | "module_off" | "sin_cupo"> | ManualInvalid> {
  if (!can(ctx.role, "manage_appointments")) return fail("forbidden");
  const details: string[] = [];
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 120) details.push("Escribe el nombre del cliente.");
  const party = Number(input.partySize);
  if (!Number.isInteger(party) || party < 1 || party > 100) details.push("El número de personas debe ser de 1 a 100.");
  const date = typeof input.date === "string" ? parseDateKey(input.date) : null;
  if (!date) details.push("La fecha no es válida.");
  const time = typeof input.time === "string" ? /^(\d{1,2}):(\d{2})$/.exec(input.time.trim()) : null;
  const minutes = time ? Number(time[1]) * 60 + Number(time[2]) : -1;
  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) details.push("La hora no es válida (por ejemplo 20:30).");
  const notes = typeof input.notes === "string" ? input.notes.trim().slice(0, 200) || null : null;
  if (details.length > 0) return { ok: false, error: "invalid", details };

  const tz = await withTenant(db, scope(ctx), async (tx) => {
    const denied = await restaurantGate(tx, ctx, true);
    if (denied) return denied;
    const [t] = await tx.select({ tz: tenants.timezone }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    return t?.tz ?? "America/Merida";
  });
  if (typeof tz !== "string") return tz;

  const startsAt = zonedTimeToUtc(date!, minutes, tz);
  if (startsAt.getTime() < now.getTime() - 3 * 3_600_000) return { ok: false, error: "invalid", details: ["Esa hora ya pasó."] };

  // El cliente: el que ya tenga ese telefono, o uno nuevo.
  const created = await createCustomer(db, ctx, { displayName: name, phone: input.phone });
  let contactId: string;
  if (created.ok) contactId = created.id;
  else if (created.error === "phone_taken") contactId = created.otherId;
  else if (created.error === "invalid") return { ok: false, error: "invalid", details: created.details };
  else return fail("forbidden");

  return withTenant(db, scope(ctx), async (tx) => {
    const env = await loadReservationEnv(tx);
    const [contact] = await tx.execute<{ display_name: string | null; phone_e164: string | null }>(sql`select display_name, phone_e164 from contacts where id = ${contactId}`);
    const r = await reserveSeats(
      tx,
      {
        tenantId: ctx.tenantId,
        contactId,
        conversationId: null,
        channel: "panel",
        customerName: name,
        customerPhone: contact?.phone_e164 ?? null,
        partySize: party,
        startsAt,
        notes,
        createdBy: "panel",
        idempotencyKey: null,
        now,
        ignoreCapacity: input.ignoreCapacity === true,
      },
      env.settings,
    );
    if (!r.ok) return fail("sin_cupo" as const);
    if (!r.duplicate) {
      await tx.insert(auditLog).values({ tenantId: ctx.tenantId, userId: ctx.userId, action: "reservation.created", entity: "reservation", entityId: r.reservation.id, diff: { actor: "panel", number: r.reservation.number, partySize: party, overbooked: r.overbooked } });
    }
    return { ok: true as const, reservation: toView(r.reservation), overbooked: r.overbooked };
  });
}

// -------------------------------------------------------------------------------------- ajustes

export type ReservationSettingsView = {
  settings: Pick<
    RestaurantSettingsRow,
    | "reservationsEnabled"
    | "reservationsCapacity"
    | "reservationsStayMinutes"
    | "reservationsSlotMinutes"
    | "reservationsMaxParty"
    | "reservationsMinNoticeMinutes"
    | "reservationsMaxDaysAhead"
    | "reservationsLastSeatingMinutes"
  >;
  /** Sin horario general cargado el asistente no puede ofrecer horas. */
  hoursConfigured: boolean;
};

export async function getReservationSettings(db: Database, ctx: PanelContext): Promise<Success<ReservationSettingsView> | Failure<"module_off">> {
  return withTenant(db, scope(ctx), async (tx) => {
    if (await restaurantGate(tx, ctx, false)) return fail("module_off" as const);
    const [hours] = await tx.select({ n: sql<number>`count(*)::int` }).from(businessHours).where(isNull(businessHours.staffId));
    return { ok: true as const, settings: await loadRestaurantSettings(tx), hoursConfigured: Number(hours?.n ?? 0) > 0 };
  });
}

const intIn = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === "string" ? Number(v.trim()) : Number(v);
  return v !== "" && v !== null && v !== undefined && Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** Guarda SOLO los ajustes de reservaciones (no toca los de pedidos). Dueno y recepcion. */
export async function saveReservationSettings(db: Database, ctx: PanelContext, input: Record<string, unknown>): Promise<Success<ReservationSettingsView> | Failure<"forbidden" | "module_off"> | ManualInvalid> {
  const errors: string[] = [];
  const capacity = intIn(input.capacity, 1, 2000);
  if (capacity === null) errors.push("El aforo debe ser de 1 a 2000 personas.");
  const stay = intIn(input.stayMinutes, 30, 480);
  if (stay === null) errors.push("La duración de la mesa debe ser de 30 a 480 minutos.");
  const slot = intIn(input.slotMinutes, 15, 60);
  if (slot === null || ![15, 30, 60].includes(slot)) errors.push("Las horas se ofrecen cada 15, 30 o 60 minutos.");
  const maxParty = intIn(input.maxParty, 1, 100);
  if (maxParty === null) errors.push("El grupo máximo debe ser de 1 a 100 personas.");
  else if (capacity !== null && maxParty > capacity) errors.push("El grupo máximo no puede ser mayor al aforo.");
  const notice = intIn(input.minNoticeMinutes, 0, 10080);
  if (notice === null) errors.push("El aviso mínimo debe ser de 0 a 10,080 minutos.");
  const ahead = intIn(input.maxDaysAhead, 1, 365);
  if (ahead === null) errors.push("Los días de anticipación deben ser de 1 a 365.");
  const last = intIn(input.lastSeatingMinutes ?? 60, 0, 480);
  if (last === null) errors.push("Los minutos antes del cierre deben ser de 0 a 480.");
  if (errors.length > 0) return { ok: false, error: "invalid", details: errors };

  return withTenant(db, scope(ctx), async (tx) => {
    const denied = await restaurantGate(tx, ctx, true);
    if (denied) return denied;
    const values = {
      reservationsEnabled: input.enabled === true,
      reservationsCapacity: capacity!,
      reservationsStayMinutes: stay!,
      reservationsSlotMinutes: slot!,
      reservationsMaxParty: maxParty!,
      reservationsMinNoticeMinutes: notice!,
      reservationsMaxDaysAhead: ahead!,
      reservationsLastSeatingMinutes: last!,
      updatedAt: new Date(),
    };
    await tx.insert(restaurantSettings).values({ tenantId: ctx.tenantId, ...values }).onConflictDoUpdate({ target: restaurantSettings.tenantId, set: values });
    await tx.insert(auditLog).values({ tenantId: ctx.tenantId, userId: ctx.userId, action: "reservation.settings", entity: "restaurant_settings", entityId: ctx.tenantId, diff: { enabled: values.reservationsEnabled, capacity, stay, slot, maxParty } as never });
    const [hours] = await tx.select({ n: sql<number>`count(*)::int` }).from(businessHours).where(isNull(businessHours.staffId));
    return { ok: true as const, settings: await loadRestaurantSettings(tx), hoursConfigured: Number(hours?.n ?? 0) > 0 };
  });
}
