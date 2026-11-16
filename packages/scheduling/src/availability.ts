import {
  addDays,
  compareDates,
  dateKey,
  localDate,
  parseHM,
  weekdayOf,
  zonedTimeToUtc,
} from "./time";

/** Ventana de trabajo de un dia de la semana (0 = domingo). Horas en hora local del negocio. */
export interface TimeWindow {
  weekday: number;
  opens: string; // "09:00" o "09:00:00"
  closes: string;
}

export interface Interval {
  start: Date;
  end: Date;
}

export interface StaffAvailabilityInput {
  staffId: string;
  /**
   * Horario propio del empleado. Si tiene AL MENOS una ventana, solo trabaja en ellas
   * (siempre dentro del horario del negocio). Vacio = sigue el horario del negocio.
   */
  hours: TimeWindow[];
  /** Dias libres propios, "YYYY-MM-DD". */
  holidays: string[];
  /** Citas ya agendadas, con su buffer incluido (usa busyInterval). */
  busy: Interval[];
}

export interface AvailabilityInput {
  timezone: string;
  /** Rango a buscar en UTC: [from, to). */
  from: Date;
  to: Date;
  now: Date;
  service: { durationMin: number; bufferMin: number };
  businessHours: TimeWindow[];
  /** Festivos del negocio, "YYYY-MM-DD". */
  businessHolidays: string[];
  /** Solo los empleados que realizan el servicio (el filtro lo hace quien llama). */
  staff: StaffAvailabilityInput[];
  /** Separacion entre horarios ofrecidos. Por defecto 15. */
  stepMin?: number;
  /** Anticipacion minima para agendar. Por defecto 60. */
  minNoticeMin?: number;
}

export interface Slot {
  staffId: string;
  start: Date;
  end: Date;
}

type Range = [startMin: number, endMin: number];

const MINUTE = 60_000;

/** Intervalo ocupado por una cita: incluye el buffer posterior (limpieza, preparacion). */
export function busyInterval(startsAt: Date, endsAt: Date, bufferMin: number): Interval {
  return { start: startsAt, end: new Date(endsAt.getTime() + bufferMin * MINUTE) };
}

function windowsFor(hours: TimeWindow[], weekday: number): Range[] {
  return hours
    .filter((w) => w.weekday === weekday)
    .map((w): Range => [parseHM(w.opens), parseHM(w.closes)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
}

function intersect(a: Range[], b: Range[]): Range[] {
  const out: Range[] = [];
  for (const [as, ae] of a) {
    for (const [bs, be] of b) {
      const start = Math.max(as, bs);
      const end = Math.min(ae, be);
      if (start < end) out.push([start, end]);
    }
  }
  return out.sort((x, y) => x[0] - y[0]);
}

/**
 * Calcula los horarios REALMENTE disponibles. Es logica de negocio pura (sin base de datos
 * ni IA): el agente solo propone lo que esta funcion devuelve.
 *
 * Un horario es valido si:
 *  - cae dentro del horario del negocio (y del propio del empleado, si lo tiene);
 *  - el dia no es festivo del negocio ni dia libre del empleado;
 *  - respeta la anticipacion minima;
 *  - la cita (duracion + buffer) no se traslapa con ninguna cita existente del empleado.
 */
export function computeAvailability(input: AvailabilityInput): Slot[] {
  const { timezone, service } = input;
  if (service.durationMin <= 0) throw new Error("La duracion del servicio debe ser positiva");
  const step = input.stepMin ?? 15;
  if (step <= 0) throw new Error("stepMin debe ser positivo");
  const notice = input.minNoticeMin ?? 60;

  const fromMs = input.from.getTime();
  const toMs = input.to.getTime();
  if (toMs <= fromMs) return [];
  const earliestMs = Math.max(fromMs, input.now.getTime() + notice * MINUTE);

  const businessHolidays = new Set(input.businessHolidays);
  const staffHolidays = new Map(input.staff.map((s) => [s.staffId, new Set(s.holidays)]));

  const firstDay = localDate(input.from, timezone);
  const lastDay = localDate(new Date(toMs - 1), timezone);
  const occupiedMin = service.durationMin + service.bufferMin;

  const slots: Slot[] = [];
  for (let day = firstDay; compareDates(day, lastDay) <= 0; day = addDays(day, 1)) {
    const key = dateKey(day);
    if (businessHolidays.has(key)) continue;

    const weekday = weekdayOf(day);
    const businessRanges = windowsFor(input.businessHours, weekday);
    if (businessRanges.length === 0) continue;

    for (const member of input.staff) {
      if (staffHolidays.get(member.staffId)?.has(key)) continue;

      const ranges =
        member.hours.length > 0
          ? intersect(windowsFor(member.hours, weekday), businessRanges)
          : businessRanges;

      for (const [open, close] of ranges) {
        for (let t = open; t + service.durationMin <= close; t += step) {
          const startMs = zonedTimeToUtc(day, t, timezone).getTime();
          if (startMs < earliestMs || startMs >= toMs) continue;

          const occupiedEndMs = startMs + occupiedMin * MINUTE;
          const clashes = member.busy.some(
            (b) => startMs < b.end.getTime() && b.start.getTime() < occupiedEndMs,
          );
          if (clashes) continue;

          slots.push({
            staffId: member.staffId,
            start: new Date(startMs),
            end: new Date(startMs + service.durationMin * MINUTE),
          });
        }
      }
    }
  }

  return slots.sort(
    (a, b) => a.start.getTime() - b.start.getTime() || a.staffId.localeCompare(b.staffId),
  );
}

/**
 * Elige pocas opciones concretas para ofrecer al cliente: primero la mas temprana de cada
 * dia distinto y, si faltan, otras del mismo dia separadas al menos `minGapMin`.
 * Nunca repite la misma hora aunque la tengan varios empleados.
 */
export function pickOptions(slots: Slot[], timezone: string, max = 3, minGapMin = 60): Slot[] {
  const sorted = [...slots].sort((a, b) => a.start.getTime() - b.start.getTime());
  const picked: Slot[] = [];
  const seenDays = new Set<string>();

  for (const slot of sorted) {
    if (picked.length >= max) break;
    const day = dateKey(localDate(slot.start, timezone));
    if (seenDays.has(day)) continue;
    seenDays.add(day);
    picked.push(slot);
  }

  for (const slot of sorted) {
    if (picked.length >= max) break;
    const farEnough = picked.every(
      (p) => Math.abs(p.start.getTime() - slot.start.getTime()) >= minGapMin * MINUTE,
    );
    if (farEnough) picked.push(slot);
  }

  return picked.sort((a, b) => a.start.getTime() - b.start.getTime());
}
