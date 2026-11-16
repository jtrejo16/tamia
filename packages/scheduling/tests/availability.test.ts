import { describe, expect, it } from "vitest";
import {
  busyInterval,
  computeAvailability,
  pickOptions,
  type AvailabilityInput,
  type TimeWindow,
} from "../src/availability";
import { addDays, localParts, parseHM, weekdayOf, zonedTimeToUtc } from "../src/time";

const TZ = "America/Merida"; // UTC-6 todo el anio (sin horario de verano)

// Marzo 2027: lunes 1, martes 2, miercoles 3, sabado 6.
const at = (day: number, h: number, m = 0) => new Date(Date.UTC(2027, 2, day, h + 6, m));
const dayRange = (day: number, days = 1) => ({ from: at(day, 0), to: at(day + days, 0) });
const localHM = (d: Date) => {
  const p = localParts(d, TZ);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

const weekdays = (days: number[], opens: string, closes: string): TimeWindow[] =>
  days.map((weekday) => ({ weekday, opens, closes }));

// Lun-Vie 9-19, Sab 9-14 (igual que el seed de la clinica demo).
const BUSINESS: TimeWindow[] = [
  ...weekdays([1, 2, 3, 4, 5], "09:00", "19:00"),
  ...weekdays([6], "09:00", "14:00"),
];

function input(overrides: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    timezone: TZ,
    ...dayRange(2),
    now: at(1, 12),
    service: { durationMin: 45, bufferMin: 10 },
    businessHours: BUSINESS,
    businessHolidays: [],
    staff: [{ staffId: "ruiz", hours: [], holidays: [], busy: [] }],
    ...overrides,
  };
}

const starts = (slots: { start: Date }[]) => slots.map((s) => localHM(s.start));

describe("zonas horarias", () => {
  it("Merida es UTC-6 todo el anio", () => {
    expect(zonedTimeToUtc({ year: 2027, month: 3, day: 2 }, parseHM("09:00"), TZ).toISOString()).toBe(
      "2027-03-02T15:00:00.000Z",
    );
    expect(zonedTimeToUtc({ year: 2027, month: 7, day: 1 }, parseHM("09:00"), TZ).toISOString()).toBe(
      "2027-07-01T15:00:00.000Z",
    );
  });

  it("respeta el cambio de horario en una zona con verano (Nueva York, 14-mar-2027)", () => {
    const ny = "America/New_York";
    expect(zonedTimeToUtc({ year: 2027, month: 3, day: 13 }, 540, ny).toISOString()).toBe(
      "2027-03-13T14:00:00.000Z",
    );
    expect(zonedTimeToUtc({ year: 2027, month: 3, day: 15 }, 540, ny).toISOString()).toBe(
      "2027-03-15T13:00:00.000Z",
    );
  });

  it("calcula dia de la semana y suma dias de calendario", () => {
    expect(weekdayOf({ year: 2027, month: 3, day: 2 })).toBe(2); // martes
    expect(addDays({ year: 2027, month: 2, day: 28 }, 1)).toEqual({ year: 2027, month: 3, day: 1 });
  });

  it("rechaza horas invalidas", () => {
    expect(() => parseHM("9am")).toThrow();
    expect(() => parseHM("10:75")).toThrow();
  });
});

describe("disponibilidad", () => {
  it("un martes libre ofrece de 09:00 a 18:15 cada 15 min (45 min caben hasta las 19:00)", () => {
    const result = starts(computeAvailability(input()));
    expect(result[0]).toBe("09:00");
    expect(result.at(-1)).toBe("18:15");
    expect(result).toHaveLength(38);
  });

  it("devuelve los horarios en UTC correcto", () => {
    const [first] = computeAvailability(input());
    expect(first?.start.toISOString()).toBe("2027-03-02T15:00:00.000Z");
    expect(first?.end.toISOString()).toBe("2027-03-02T15:45:00.000Z");
  });

  it("una cita existente bloquea los horarios que se le traslapan, incluido su buffer", () => {
    // Cita 10:00-10:45 + 10 min de buffer = ocupado hasta 10:55.
    const busy = [busyInterval(at(2, 10), at(2, 10, 45), 10)];
    const result = starts(
      computeAvailability(input({ staff: [{ staffId: "ruiz", hours: [], holidays: [], busy }] })),
    );
    expect(result).toContain("09:00"); // 09:00-09:45 (+10) termina 09:55: libre
    expect(result).not.toContain("09:15"); // su buffer chocaria con la cita de las 10:00
    expect(result).not.toContain("10:30");
    expect(result).not.toContain("10:45");
    expect(result).toContain("11:00");
  });

  it("el buffer del servicio nuevo tambien cuenta", () => {
    const busy = [busyInterval(at(2, 11), at(2, 12), 0)];
    const withBuffer = starts(
      computeAvailability(
        input({
          service: { durationMin: 45, bufferMin: 30 },
          staff: [{ staffId: "ruiz", hours: [], holidays: [], busy }],
        }),
      ),
    );
    // Un servicio de 45 min + 30 de buffer ocupa 75 min.
    expect(withBuffer).not.toContain("10:00"); // 10:00 + 75 min = 11:15, choca con la cita de las 11:00
    expect(withBuffer).toContain("09:45"); // 09:45 + 75 min = 11:00 exacto: justo cabe
  });

  it("respeta la anticipacion minima", () => {
    const result = starts(computeAvailability(input({ now: at(2, 9, 30) })));
    expect(result[0]).toBe("10:30");
  });

  it("no ofrece nada en dias festivos del negocio ni en dias libres del empleado", () => {
    expect(computeAvailability(input({ businessHolidays: ["2027-03-02"] }))).toEqual([]);
    expect(
      computeAvailability(
        input({ staff: [{ staffId: "ruiz", hours: [], holidays: ["2027-03-02"], busy: [] }] }),
      ),
    ).toEqual([]);
  });

  it("el sabado cierra a las 14:00", () => {
    const result = starts(computeAvailability(input({ ...dayRange(6), now: at(1, 12) })));
    expect(result.at(-1)).toBe("13:15");
  });

  it("no ofrece domingos (sin horario)", () => {
    expect(computeAvailability(input({ ...dayRange(7) }))).toEqual([]);
  });

  it("el horario propio del empleado limita su disponibilidad (Dr. Mena: lun/mie/vie 9-15)", () => {
    const mena = {
      staffId: "mena",
      hours: weekdays([1, 3, 5], "09:00", "15:00"),
      holidays: [],
      busy: [],
    };
    // "now" = domingo: asi el lunes completo esta en el futuro.
    const monday = starts(
      computeAvailability(input({ ...dayRange(1), now: at(0, 12), staff: [mena] })),
    );
    expect(monday[0]).toBe("09:00");
    expect(monday.at(-1)).toBe("14:15");
    // El martes no trabaja: tiene horario propio y ninguna ventana ese dia.
    expect(computeAvailability(input({ ...dayRange(2), staff: [mena] }))).toEqual([]);
  });

  it("el horario propio nunca excede el del negocio", () => {
    const longHours = { staffId: "x", hours: weekdays([6], "08:00", "20:00"), holidays: [], busy: [] };
    const result = starts(computeAvailability(input({ ...dayRange(6), staff: [longHours] })));
    expect(result[0]).toBe("09:00");
    expect(result.at(-1)).toBe("13:15");
  });

  it("soporta descanso a mediodia (dos ventanas el mismo dia)", () => {
    const split = {
      staffId: "ruiz",
      hours: [
        { weekday: 2, opens: "09:00", closes: "14:00" },
        { weekday: 2, opens: "16:00", closes: "19:00" },
      ],
      holidays: [],
      busy: [],
    };
    const result = starts(computeAvailability(input({ staff: [split] })));
    expect(result).toContain("13:15");
    expect(result).not.toContain("13:30"); // 13:30 + 45 min pasa de las 14:00
    expect(result).not.toContain("15:00");
    expect(result).toContain("16:00");
  });

  it("combina varios empleados y los ordena por hora", () => {
    const result = computeAvailability(
      input({
        staff: [
          { staffId: "ruiz", hours: [], holidays: [], busy: [busyInterval(at(2, 9), at(2, 9, 45), 10)] },
          { staffId: "mena", hours: [], holidays: [], busy: [] },
        ],
      }),
    );
    const nine = result.filter((s) => localHM(s.start) === "09:00");
    expect(nine.map((s) => s.staffId)).toEqual(["mena"]); // Ruiz esta ocupada a las 9
  });

  it("cada cliente ve horarios en SU zona: el rango UTC no se corta por el cambio de dia", () => {
    // Rango que empieza a las 23:00 locales del lunes: aun asi encuentra el martes.
    const result = computeAvailability(input({ from: at(1, 23), to: at(3, 0) }));
    expect(localHM(result[0]!.start)).toBe("09:00");
  });

  it("valida entradas absurdas", () => {
    expect(() => computeAvailability(input({ service: { durationMin: 0, bufferMin: 0 } }))).toThrow();
    expect(computeAvailability(input({ from: at(3, 0), to: at(2, 0) }))).toEqual([]);
  });
});

describe("pickOptions", () => {
  it("ofrece como maximo 3 opciones, una por dia cuando hay varios dias", () => {
    const slots = computeAvailability(input({ ...dayRange(2, 3) }));
    const options = pickOptions(slots, TZ, 3);
    expect(options).toHaveLength(3);
    expect(new Set(options.map((o) => o.start.toISOString().slice(0, 10))).size).toBe(3);
  });

  it("si solo hay un dia, separa las opciones al menos 60 min", () => {
    const slots = computeAvailability(input());
    const options = pickOptions(slots, TZ, 3);
    expect(starts(options)).toEqual(["09:00", "10:00", "11:00"]);
  });

  it("no repite la misma hora aunque la tengan varios empleados", () => {
    const slots = computeAvailability(
      input({
        staff: [
          { staffId: "a", hours: [], holidays: [], busy: [] },
          { staffId: "b", hours: [], holidays: [], busy: [] },
        ],
      }),
    );
    const options = pickOptions(slots, TZ, 3);
    expect(new Set(starts(options)).size).toBe(options.length);
  });

  it("devuelve lista vacia sin horarios", () => {
    expect(pickOptions([], TZ)).toEqual([]);
  });
});
