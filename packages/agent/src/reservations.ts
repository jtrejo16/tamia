import {
  businessHolidays,
  businessHours,
  channels,
  conversations,
  loadRestaurantSettings,
  reservations,
  type RestaurantSettingsRow,
  type Tx,
} from "@empleado/db";
import { addDays, dateKey, localDate, parseHM, weekdayOf, zonedTimeToUtc, type LocalDate } from "@empleado/scheduling";
import { and, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";

/**
 * Reservaciones por aforo: el restaurante tiene un numero de lugares que caben al mismo tiempo (aforo) y cada reservacion ocupa
 * los de su grupo durante la estancia estimada. NO hay mesas: se reserva mientras el grupo quepa en el aforo en TODO el rato que
 * ocuparia. Todo el calculo (horas ofrecidas, cupo) lo hace el codigo; el modelo solo pide una fecha, una hora y un numero.
 * Lo usan las herramientas del agente (texto y voz) y el panel (alta manual).
 */

export type ReservationSettings = Pick<
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

export interface Occupancy {
  startsAt: Date;
  endsAt: Date;
  partySize: number;
}

export interface HoursWindow {
  weekday: number;
  opens: string;
  closes: string;
}

export interface Slot {
  startsAt: Date;
  /** "20:30", hora local del negocio. */
  label: string;
}

/** Estados que ocupan lugar en el aforo. */
export const OCCUPYING = ["confirmed", "seated"] as const;

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (minutes: number) => `${pad(Math.floor((minutes % 1440) / 60))}:${pad(minutes % 60)}`;

/** Maximo de comensales sentados a la vez durante [start, end) con las reservaciones dadas. */
export function peakSeats(existing: Occupancy[], start: Date, end: Date): number {
  const inside = existing.filter((r) => r.startsAt < end && r.endsAt > start);
  // El maximo se alcanza en el inicio de alguna reservacion (o en el del intervalo): se revisan esos instantes.
  const points = [start.getTime(), ...inside.map((r) => r.startsAt.getTime()).filter((t) => t > start.getTime() && t < end.getTime())];
  let peak = 0;
  for (const t of points) {
    const seats = inside.filter((r) => r.startsAt.getTime() <= t && r.endsAt.getTime() > t).reduce((s, r) => s + r.partySize, 0);
    peak = Math.max(peak, seats);
  }
  return peak;
}

/** ¿Cabe un grupo de `party` en [start, end) sin pasar el aforo? */
export function fits(existing: Occupancy[], start: Date, end: Date, party: number, capacity: number): boolean {
  return party >= 1 && party <= capacity && peakSeats(existing, start, end) + party <= capacity;
}

export const endOfStay = (start: Date, s: Pick<ReservationSettings, "reservationsStayMinutes">): Date => new Date(start.getTime() + s.reservationsStayMinutes * 60_000);

/** Por que no se puede ofrecer nada ese dia (para decirselo al cliente con claridad). */
export type DayStatus = "ok" | "party_too_big" | "past" | "too_far" | "closed" | "full" | "too_soon";

export interface DaySlots {
  status: DayStatus;
  slots: Slot[];
}

/**
 * Las horas que se pueden reservar en un dia para un grupo. Parte del horario del negocio (con turnos que cruzan la medianoche
 * y dias de cierre), las ofrece cada `slot` minutos, la ultima es el cierre menos `lastSeating`, y descarta las que ya pasaron,
 * las muy cercanas (aviso minimo), las muy lejanas y las que no caben en el aforo.
 */
export function slotsForDate(input: {
  date: LocalDate;
  timeZone: string;
  hours: HoursWindow[];
  holidays: string[];
  settings: ReservationSettings;
  existing: Occupancy[];
  party: number;
  now: Date;
}): DaySlots {
  const { date, timeZone, hours, holidays, settings: s, existing, party, now } = input;
  if (party > s.reservationsMaxParty || party > s.reservationsCapacity || party < 1) return { status: "party_too_big", slots: [] };

  const today = localDate(now, timeZone);
  if (dateKey(date) < dateKey(today)) return { status: "past", slots: [] };
  if (dateKey(date) > dateKey(addDays(today, s.reservationsMaxDaysAhead))) return { status: "too_far", slots: [] };

  const closed = new Set(holidays);
  const earliest = now.getTime() + s.reservationsMinNoticeMinutes * 60_000;
  const candidates: Slot[] = [];
  let anyWindow = false;
  let tooSoon = false;

  // Turnos que ABREN este dia, y los de AYER que cruzan la medianoche (su tramo de madrugada cae en este dia).
  for (const offset of [-1, 0]) {
    const day = addDays(date, offset);
    if (closed.has(dateKey(day))) continue;
    for (const h of hours.filter((w) => w.weekday === weekdayOf(day))) {
      const from = parseHM(h.opens);
      let to = parseHM(h.closes);
      if (to <= from) to += 1440;
      const last = to - s.reservationsLastSeatingMinutes;
      for (let m = Math.ceil(from / s.reservationsSlotMinutes) * s.reservationsSlotMinutes; m <= last; m += s.reservationsSlotMinutes) {
        const startsAt = zonedTimeToUtc(day, m, timeZone);
        if (dateKey(localDate(startsAt, timeZone)) !== dateKey(date)) continue;
        anyWindow = true;
        if (startsAt.getTime() < earliest) {
          tooSoon = true;
          continue;
        }
        candidates.push({ startsAt, label: clock(m) });
      }
    }
  }
  if (!anyWindow) return { status: "closed", slots: [] };

  const seen = new Set<string>();
  const slots = candidates
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .filter((c) => (seen.has(c.label) ? false : (seen.add(c.label), true)))
    .filter((c) => fits(existing, c.startsAt, endOfStay(c.startsAt, s), party, s.reservationsCapacity));
  if (slots.length === 0) return { status: tooSoon && candidates.length === 0 ? "too_soon" : "full", slots: [] };
  return { status: "ok", slots };
}

/** Hasta `max` horas para ofrecer: las mas cercanas a la preferida, o repartidas en el dia si no hay preferida. En orden. */
export function pickSlots(slots: Slot[], preferred: string | null, max = 4): Slot[] {
  if (slots.length <= max) return slots;
  if (preferred) {
    const want = parseHM(preferred);
    const minutesOf = (l: string) => parseHM(l);
    return [...slots]
      .sort((a, b) => Math.abs(minutesOf(a.label) - want) - Math.abs(minutesOf(b.label) - want))
      .slice(0, max)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  }
  const step = (slots.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => slots[Math.round(i * step)]!);
}

// ------------------------------------------------------------------------------------------ base de datos

export interface ReservationEnv {
  settings: RestaurantSettingsRow;
  hours: HoursWindow[];
  holidays: string[];
}

/** Ajustes y horario general del negocio (el que no es de un especialista). */
export async function loadReservationEnv(tx: Tx): Promise<ReservationEnv> {
  const [settings, hours, holidays] = await Promise.all([
    loadRestaurantSettings(tx),
    tx.select().from(businessHours).where(isNull(businessHours.staffId)),
    tx.select().from(businessHolidays).where(isNull(businessHolidays.staffId)),
  ]);
  return { settings, hours: hours.map((h) => ({ weekday: h.weekday, opens: h.opens, closes: h.closes })), holidays: holidays.map((h) => String(h.date)) };
}

/** Lo que ocupa lugar en un rango (con margen de la estancia hacia atras, para atrapar las que apenas empezaron). */
export async function loadOccupancy(tx: Tx, from: Date, to: Date): Promise<Occupancy[]> {
  const rows = await tx
    .select({ startsAt: reservations.startsAt, endsAt: reservations.endsAt, partySize: reservations.partySize })
    .from(reservations)
    .where(and(inArray(reservations.status, [...OCCUPYING]), lt(reservations.startsAt, to), gt(reservations.endsAt, from)));
  return rows;
}

/** Horas libres de UN dia para un grupo, leyendo el aforo actual. */
export async function daySlots(tx: Tx, env: ReservationEnv, input: { date: LocalDate; timeZone: string; party: number; now: Date }): Promise<DaySlots> {
  const dayStart = zonedTimeToUtc(addDays(input.date, -1), 0, input.timeZone);
  const dayEnd = zonedTimeToUtc(addDays(input.date, 2), 0, input.timeZone);
  const existing = await loadOccupancy(tx, dayStart, dayEnd);
  return slotsForDate({ date: input.date, timeZone: input.timeZone, hours: env.hours, holidays: env.holidays, settings: env.settings, existing, party: input.party, now: input.now });
}

export interface ReserveInput {
  tenantId: string;
  contactId: string;
  conversationId: string | null;
  channel: string;
  customerName: string;
  customerPhone: string | null;
  partySize: number;
  startsAt: Date;
  notes: string | null;
  createdBy: "bot" | "panel";
  idempotencyKey: string | null;
  now: Date;
  /** Alguien del equipo decide reservar aunque pase el aforo (por ejemplo, un cliente de la casa). El asistente nunca lo usa. */
  ignoreCapacity?: boolean;
}

export type ReserveResult =
  | { ok: true; reservation: typeof reservations.$inferSelect; duplicate: boolean; overbooked: boolean }
  | { ok: false; reason: "sin_cupo" };

/**
 * Crea la reservacion de forma segura: toma un candado por negocio, vuelve a revisar el aforo (otra persona pudo ocupar el lugar
 * hace un instante) y asigna el siguiente numero. Si el mismo cliente ya tiene una reservacion confirmada a esa misma hora, la
 * devuelve en vez de duplicarla.
 */
export async function reserveSeats(tx: Tx, input: ReserveInput, settings: ReservationSettings): Promise<ReserveResult> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.tenantId}, 1))`); // reservaciones de un negocio, de una en una

  const [dup] = await tx
    .select()
    .from(reservations)
    .where(and(eq(reservations.contactId, input.contactId), eq(reservations.startsAt, input.startsAt), inArray(reservations.status, [...OCCUPYING])));
  if (dup) return { ok: true, reservation: dup, duplicate: true, overbooked: false };

  const endsAt = endOfStay(input.startsAt, settings);
  const existing = await loadOccupancy(tx, input.startsAt, endsAt);
  const room = fits(existing, input.startsAt, endsAt, input.partySize, settings.reservationsCapacity);
  if (!room && !input.ignoreCapacity) return { ok: false, reason: "sin_cupo" };

  const [last] = await tx.select({ n: sql<number>`coalesce(max(${reservations.number}), 0)` }).from(reservations);
  const [row] = await tx
    .insert(reservations)
    .values({
      tenantId: input.tenantId,
      number: Number(last?.n ?? 0) + 1,
      contactId: input.contactId,
      conversationId: input.conversationId,
      channel: input.channel,
      status: "confirmed",
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      partySize: input.partySize,
      startsAt: input.startsAt,
      endsAt,
      notes: input.notes,
      createdBy: input.createdBy,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  return { ok: true, reservation: row!, duplicate: false, overbooked: !room };
}

/** Canal por el que escribe el cliente (para el tablero y los avisos). */
export async function conversationChannel(tx: Tx, conversationId: string | null): Promise<string> {
  if (!conversationId) return "panel";
  const [row] = await tx.select({ type: channels.type }).from(conversations).innerJoin(channels, eq(channels.id, conversations.channelId)).where(eq(conversations.id, conversationId));
  return row?.type ?? "whatsapp";
}
