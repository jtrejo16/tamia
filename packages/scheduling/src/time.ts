/**
 * Utilidades de zona horaria sin dependencias externas (usa Intl).
 * Toda la agenda se calcula en la hora LOCAL del negocio y se guarda en UTC.
 */

export interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

export interface LocalParts extends LocalDate {
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Fecha y hora que marca el reloj de `timeZone` en el instante `date`. */
export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Zona horaria invalida: ${timeZone}`);
    return Number(part.value);
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

export function localDate(date: Date, timeZone: string): LocalDate {
  const { year, month, day } = localParts(date, timeZone);
  return { year, month, day };
}

/** Diferencia (ms) entre la hora local y UTC en ese instante. Negativa al oeste de Greenwich. */
export function tzOffsetMs(timeZone: string, utcMs: number): number {
  const p = localParts(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Convierte "esta fecha local a estos minutos desde la medianoche" a un instante UTC.
 * Se ajusta dos veces para acertar tambien en dias de cambio de horario.
 */
export function zonedTimeToUtc(date: LocalDate, minutesFromMidnight: number, timeZone: string): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day) + minutesFromMidnight * 60_000;
  let utc = naive - tzOffsetMs(timeZone, naive);
  utc = naive - tzOffsetMs(timeZone, utc);
  return new Date(utc);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 0 = domingo ... 6 = sabado (igual que la columna weekday de la base de datos). */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function dateKey(date: LocalDate): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  return dateKey(a).localeCompare(dateKey(b));
}

/** "09:00" o "09:00:00" -> 540 minutos. */
export function parseHM(value: string): number {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!match) throw new Error(`Hora invalida: "${value}"`);
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (Number(match[1]) > 24 || Number(match[2]) > 59) throw new Error(`Hora invalida: "${value}"`);
  return minutes;
}
