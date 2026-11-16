import { addDays, localDate, parseHM, weekdayOf, zonedTimeToUtc } from "@empleado/scheduling";
import { weekdayName } from "./format";

const KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export type HumanHours = Record<string, [string, string] | null>;

export interface HumanAvailability {
  /** Hay alguien del equipo atendiendo en este momento. */
  openNow: boolean;
  /** "hoy a las 09:00", "mañana a las 09:00", "el lunes a las 09:00". Nulo si no hay horario. */
  nextOpenText: string | null;
}

/** Cuando puede contestar una persona. Sin horario configurado se asume siempre disponible. */
export function humanAvailability(
  hours: HumanHours | null | undefined,
  now: Date,
  timeZone: string,
): HumanAvailability {
  if (!hours || Object.keys(hours).length === 0) return { openNow: true, nextOpenText: null };

  const today = localDate(now, timeZone);
  for (let offset = 0; offset <= 7; offset++) {
    const day = addDays(today, offset);
    const weekday = weekdayOf(day);
    const window = hours[KEYS[weekday]!];
    if (!window) continue;

    const open = zonedTimeToUtc(day, parseHM(window[0]), timeZone);
    const close = zonedTimeToUtc(day, parseHM(window[1]), timeZone);
    if (now >= open && now < close) return { openNow: true, nextOpenText: null };
    if (open > now) {
      const when =
        offset === 0 ? "hoy" : offset === 1 ? "mañana" : `el ${weekdayName(weekday)}`;
      return { openNow: false, nextOpenText: `${when} a las ${window[0]}` };
    }
  }
  return { openNow: false, nextOpenText: null };
}

/** Texto para el prompt: "lunes a viernes 09:00-19:00; sábado 09:00-14:00". */
export function describeHumanHours(hours: HumanHours | null | undefined): string {
  if (!hours || Object.keys(hours).length === 0) return "sin horario definido";
  const order = [1, 2, 3, 4, 5, 6, 0];
  const parts: string[] = [];
  for (const weekday of order) {
    const w = hours[KEYS[weekday]!];
    if (w) parts.push(`${weekdayName(weekday)} ${w[0]}-${w[1]}`);
  }
  return parts.length > 0 ? parts.join("; ") : "sin horario definido";
}
