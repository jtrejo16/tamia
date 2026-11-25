import { DEFAULT_RESTAURANT_SETTINGS } from "@empleado/db";
import { describe, expect, it } from "vitest";
import { endOfStay, fits, peakSeats, pickSlots, slotsForDate, type HoursWindow, type Occupancy, type ReservationSettings } from "../src/reservations";

const TZ = "America/Merida"; // UTC-6 sin horario de verano
const at = (iso: string) => new Date(iso);
const settings = (over: Partial<ReservationSettings> = {}): ReservationSettings => ({ ...DEFAULT_RESTAURANT_SETTINGS, reservationsEnabled: true, ...over });
const occ = (from: string, to: string, partySize: number): Occupancy => ({ startsAt: at(from), endsAt: at(to), partySize });

/** Lunes 1-mar-2027, 12:00 en Merida. */
const NOW = at("2027-03-01T18:00:00Z");
const TUESDAY = { year: 2027, month: 3, day: 2 };
const labels = (r: { slots: Array<{ label: string }> }) => r.slots.map((s) => s.label);
const open13to23: HoursWindow[] = [{ weekday: 2, opens: "13:00", closes: "23:00" }];

describe("aforo: maximo de comensales a la vez", () => {
  it("cuenta el pico real, no la suma de todas las que se traslapan", () => {
    // 10 de 20:00 a 21:30 y 10 de 21:00 a 22:30: coinciden 30 minutos.
    const list = [occ("2027-03-02T02:00:00Z", "2027-03-02T03:30:00Z", 10), occ("2027-03-02T03:00:00Z", "2027-03-02T04:30:00Z", 10)];
    expect(peakSeats(list, at("2027-03-02T02:30:00Z"), at("2027-03-02T04:00:00Z"))).toBe(20);
    // Un grupo que solo toca la primera (de 19:00 a 20:30 hora local): pico de 10.
    expect(peakSeats(list, at("2027-03-02T01:00:00Z"), at("2027-03-02T02:30:00Z"))).toBe(10);
    // Y uno que empieza cuando la primera ya termino y la segunda ya acabo antes: 0.
    expect(peakSeats(list, at("2027-03-02T05:00:00Z"), at("2027-03-02T06:30:00Z"))).toBe(0);
  });

  it("dos reservaciones consecutivas (una termina justo cuando empieza la otra) no se suman", () => {
    const list = [occ("2027-03-02T02:00:00Z", "2027-03-02T03:30:00Z", 30)];
    expect(peakSeats(list, at("2027-03-02T03:30:00Z"), at("2027-03-02T05:00:00Z"))).toBe(0);
    expect(fits(list, at("2027-03-02T03:30:00Z"), at("2027-03-02T05:00:00Z"), 30, 30)).toBe(true);
  });

  it("cabe solo si el grupo y el pico no pasan el aforo", () => {
    const list = [occ("2027-03-02T02:00:00Z", "2027-03-02T03:30:00Z", 25)];
    const s = at("2027-03-02T02:30:00Z");
    const e = at("2027-03-02T04:00:00Z");
    expect(fits(list, s, e, 5, 30)).toBe(true);
    expect(fits(list, s, e, 6, 30)).toBe(false);
    expect(fits([], s, e, 31, 30)).toBe(false); // un grupo mayor al aforo nunca cabe
    expect(fits([], s, e, 0, 30)).toBe(false);
  });

  it("la estancia dura lo configurado", () => {
    expect(endOfStay(at("2027-03-02T02:00:00Z"), { reservationsStayMinutes: 90 })).toEqual(at("2027-03-02T03:30:00Z"));
  });
});

describe("horas que se pueden reservar", () => {
  const base = { date: TUESDAY, timeZone: TZ, hours: open13to23, holidays: [] as string[], settings: settings(), existing: [] as Occupancy[], party: 4, now: NOW };

  it("ofrece cada media hora desde que abre hasta una hora antes de cerrar", () => {
    const r = slotsForDate(base);
    expect(r.status).toBe("ok");
    expect(labels(r)[0]).toBe("13:00");
    expect(labels(r).at(-1)).toBe("22:00");
    expect(r.slots).toHaveLength(19);
    expect(r.slots[0]!.startsAt).toEqual(at("2027-03-02T19:00:00Z")); // 13:00 en Merida
  });

  it("respeta el intervalo y los minutos antes del cierre", () => {
    expect(labels(slotsForDate({ ...base, settings: settings({ reservationsSlotMinutes: 60, reservationsLastSeatingMinutes: 120 }) }))).toEqual(["13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00"]);
    // Si abre a una hora «rara», las horas se alinean al reloj.
    expect(labels(slotsForDate({ ...base, hours: [{ weekday: 2, opens: "13:10", closes: "15:00" }], settings: settings({ reservationsLastSeatingMinutes: 0 }) }))).toEqual(["13:30", "14:00", "14:30", "15:00"]);
  });

  it("quita las horas cuya estancia chocaria con el aforo lleno, pero deja las de antes y de despues", () => {
    // 40 de 20:00 a 21:30 (hora local) con aforo 40: nadie mas cabe mientras esten.
    const full = occ("2027-03-03T02:00:00Z", "2027-03-03T03:30:00Z", 40);
    const r = slotsForDate({ ...base, existing: [full] });
    const l = labels(r);
    expect(l).toContain("18:30"); // termina justo a las 20:00
    expect(l).not.toContain("19:00");
    expect(l).not.toContain("21:00");
    expect(l).toContain("21:30");
  });

  it("un dia sin lugar para ese grupo lo dice", () => {
    const wall = occ("2027-03-02T19:00:00Z", "2027-03-03T06:00:00Z", 40);
    expect(slotsForDate({ ...base, existing: [wall] })).toEqual({ status: "full", slots: [] });
  });

  it("pide un poco de aviso: el mismo dia solo desde la hora minima", () => {
    const sameDay = { ...base, date: { year: 2027, month: 3, day: 1 }, hours: [{ weekday: 1, opens: "09:00", closes: "19:00" }] };
    expect(labels(slotsForDate(sameDay))[0]).toBe("13:00"); // son las 12:00 y piden 60 minutos
    expect(slotsForDate({ ...sameDay, settings: settings({ reservationsMinNoticeMinutes: 0 }) }).slots[0]!.label).toBe("12:00");
    const late = slotsForDate({ ...sameDay, now: at("2027-03-02T00:30:00Z") }); // 18:30 hora local: ya no alcanza
    expect(late.status).toBe("too_soon");
  });

  it("limites: fecha pasada, muy lejana, grupo grande, dia cerrado y dias de cierre", () => {
    expect(slotsForDate({ ...base, date: { year: 2027, month: 2, day: 28 } }).status).toBe("past");
    expect(slotsForDate({ ...base, date: { year: 2027, month: 5, day: 4 } }).status).toBe("too_far");
    expect(slotsForDate({ ...base, party: 11 }).status).toBe("party_too_big");
    expect(slotsForDate({ ...base, settings: settings({ reservationsCapacity: 6 }), party: 8 }).status).toBe("party_too_big");
    expect(slotsForDate({ ...base, date: { year: 2027, month: 3, day: 3 } }).status).toBe("closed"); // el miercoles no abre
    expect(slotsForDate({ ...base, holidays: ["2027-03-02"] }).status).toBe("closed");
  });

  it("soporta turnos que cruzan la medianoche: la madrugada cuenta para el dia siguiente y se cierra si el dia de abrir fue de cierre", () => {
    const night: HoursWindow[] = [{ weekday: 5, opens: "20:00", closes: "02:00" }]; // viernes de 8 pm a 2 am
    const friday = { year: 2027, month: 3, day: 5 };
    const saturday = { year: 2027, month: 3, day: 6 };
    expect(labels(slotsForDate({ ...base, hours: night, date: friday }))).toEqual(["20:00", "20:30", "21:00", "21:30", "22:00", "22:30", "23:00", "23:30"]);
    const early = slotsForDate({ ...base, hours: night, date: saturday });
    expect(labels(early)).toEqual(["00:00", "00:30", "01:00"]); // cierra a las 2: la ultima es a la 1
    expect(early.slots[0]!.startsAt).toEqual(at("2027-03-06T06:00:00Z"));
    expect(slotsForDate({ ...base, hours: night, date: saturday, holidays: ["2027-03-05"] }).status).toBe("closed");
  });

  it("las reservaciones de la madrugada tambien ocupan el aforo de las horas cercanas del dia anterior", () => {
    const night: HoursWindow[] = [{ weekday: 5, opens: "20:00", closes: "02:00" }];
    const late = occ("2027-03-06T05:00:00Z", "2027-03-06T06:30:00Z", 40); // 23:00 a 00:30 hora local
    const r = slotsForDate({ ...base, hours: night, date: { year: 2027, month: 3, day: 5 }, existing: [late] });
    expect(labels(r)).not.toContain("23:00");
    expect(labels(r)).not.toContain("23:30");
    expect(labels(r)).toContain("21:30");
  });
});

describe("elegir que horas ofrecer", () => {
  const mk = (labels: string[]) => labels.map((label) => ({ label, startsAt: at(`2027-03-02T${String(Number(label.slice(0, 2)) + 6).padStart(2, "0")}:${label.slice(3)}:00Z`) }));
  const all = mk(["13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30"]);

  it("si caben pocas, las da todas", () => {
    expect(pickSlots(mk(["13:00", "14:00"]), "20:00")).toHaveLength(2);
  });

  it("con hora preferida da las mas cercanas, en orden", () => {
    expect(pickSlots(all, "16:00", 3).map((s) => s.label)).toEqual(["15:30", "16:00", "16:30"]);
    expect(pickSlots(all, "07:00", 2).map((s) => s.label)).toEqual(["13:00", "13:30"]);
  });

  it("sin preferida las reparte a lo largo del dia", () => {
    const l = pickSlots(all, null, 4).map((s) => s.label);
    expect(l).toHaveLength(4);
    expect(l[0]).toBe("13:00");
    expect(l.at(-1)).toBe("17:30");
  });
});
