import { localDate, localParts, zonedTimeToUtc, type LocalDate } from "@empleado/scheduling";

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

const pad = (n: number) => String(n).padStart(2, "0");

export function weekdayName(index: number): string {
  return WEEKDAYS[index] ?? "";
}

/** "martes 2 de marzo, 10:00" en la hora local del negocio. */
export function formatLocal(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  const wd = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return `${WEEKDAYS[wd]} ${p.day} de ${MONTHS[p.month - 1]}, ${pad(p.hour)}:${pad(p.minute)}`;
}

/** "martes 2 de marzo a las 10:00": para frases como "tu cita es el ..." */
export function formatWhen(date: Date, timeZone: string): string {
  return formatLocal(date, timeZone).replace(", ", " a las ");
}

/** "martes 2 de marzo de 2027" */
export function formatDateLong(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  const wd = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return `${WEEKDAYS[wd]} ${p.day} de ${MONTHS[p.month - 1]} de ${p.year}`;
}

export function formatClock(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function formatMoney(cents: number | null | undefined, currency = "MXN"): string {
  if (cents == null) return "a valorar";
  const amount = cents / 100;
  const text = amount.toLocaleString("es-MX", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `$${text} ${currency}`;
}

/**
 * Ajusta el texto del modelo al formato de WhatsApp: *negrita* con UN asterisco, sin
 * encabezados ni enlaces Markdown. Algunos modelos (sobre todo los gratuitos) ignoran la
 * instruccion del prompt, asi que se corrige aqui para que el cliente nunca vea "**".
 */
export function toWhatsAppText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, "*$1*")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1: $2")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "2027-03-02" -> fecha local, o null si no es valida. */
export function parseDateKey(value: string): LocalDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

export function startOfLocalDay(date: LocalDate, timeZone: string): Date {
  return zonedTimeToUtc(date, 0, timeZone);
}

export function todayLocal(now: Date, timeZone: string): LocalDate {
  return localDate(now, timeZone);
}
