import { auditLog, reservations, withTenant } from "@empleado/db";
import { addDays, dateKey, parseHM } from "@empleado/scheduling";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { formatLocal, formatWhen, parseDateKey, weekdayName } from "./format";
import { defineModuleTool } from "./modules";
import { OCCUPYING, conversationChannel, daySlots, loadReservationEnv, pickSlots, reserveSeats, type DayStatus } from "./reservations";
import { confirmationGate, finishMutation, proposeAction } from "./tools";
import type { ToolResult } from "./types";

/**
 * Herramientas de reservacion de mesa del modulo "restaurante". Solo funcionan si el negocio las activo en
 * Reservaciones → Ajustes. El cupo y las horas ofrecidas los calcula el codigo (reservations.ts): el modelo solo pide una
 * fecha, una hora y un numero de personas.
 */

const confirmado = z.boolean().default(false).describe("false para obtener el resumen; true SOLO cuando el cliente ya confirmó ese resumen en su mensaje anterior.");
const fecha = z.string().trim().describe("Fecha en formato AAAA-MM-DD (hora local del negocio). Calcula la fecha exacta a partir de «hoy» y lo que dijo el cliente.");
const hora = z.string().trim().regex(/^\d{1,2}:\d{2}$/, "Usa el formato HH:MM de 24 horas").describe("Hora en formato HH:MM de 24 horas, por ejemplo 20:30.");
const personas = z.number().int().min(1).max(100).describe("Cuántas personas son (comensales).");

const NOT_AVAILABLE: ToolResult = { error: "reservaciones_no_disponibles", instruccion: "Este restaurante no toma reservaciones por este medio. Díselo con amabilidad; si quiere ir, puede llegar directamente al local." };

const timeLabel = (h: string): string => {
  const m = parseHM(h);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const validHour = (h: string): boolean => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(h);
  return Boolean(m && Number(m[1]) <= 23 && Number(m[2]) <= 59);
};

const dayName = (d: { year: number; month: number; day: number }) => weekdayName(new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay());

/** Por que no hay horas ese dia, dicho para el cliente. */
function whyNot(status: DayStatus, party: number, max: number): ToolResult {
  switch (status) {
    case "party_too_big":
      return { error: "grupo_grande", maximo: max, instruccion: `Los grupos de más de ${max} personas los atiende una persona del equipo: dile que lo pasas con ella y usa escalar_a_humano con la fecha, la hora y el número de personas.` };
    case "past":
      return { error: "fecha_pasada", instruccion: "Esa fecha ya pasó. Pregúntale para qué día quiere reservar." };
    case "too_far":
      return { error: "fecha_muy_lejana", instruccion: "Todavía no se reserva para una fecha tan lejana. Dile que lo intente más cerca de ese día." };
    case "closed":
      return { error: "cerrado_ese_dia", instruccion: "El restaurante no abre ese día (o ya no hay horario de reservación). Dile los días de atención con consultar_horario y ofrécele otro día." };
    case "too_soon":
      return { error: "muy_pronto", instruccion: "Ya no alcanza a reservarse para ese momento (se necesita un poco de aviso). Ofrécele una hora más tarde o que llegue directo al local." };
    default:
      return { error: "sin_disponibilidad", instruccion: "Ese día ya no hay lugar para ese grupo. Ofrécele otro día (puedes buscar con buscar_mesa)." };
  }
}

const buscarMesa = defineModuleTool({
  name: "buscar_mesa",
  description:
    "Busca horas disponibles para reservar mesa un día para cierto número de personas. Devuelve las horas libres reales (máximo cuatro, las más cercanas a la hora que pide el cliente). Úsala SIEMPRE antes de proponer una reservación; nunca inventes horas.",
  mutating: false,
  schema: z.object({ fecha, personas, hora_preferida: hora.optional().describe("La hora que pidió el cliente, si dijo una.") }),
  async execute(args, ctx) {
    const day = parseDateKey(args.fecha);
    if (!day) return { error: "fecha_invalida", instruccion: "Usa el formato AAAA-MM-DD." };
    if (args.hora_preferida && !validHour(args.hora_preferida)) return { error: "hora_invalida", instruccion: "Usa el formato HH:MM de 24 horas." };

    const found = await withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => {
      const env = await loadReservationEnv(tx);
      if (!env.settings.reservationsEnabled) return null;
      if (env.hours.length === 0) return { noHours: true as const };
      const main = await daySlots(tx, env, { date: day, timeZone: ctx.tenant.timezone, party: args.personas, now: ctx.now });
      // Si ese dia no hay lugar, se ven los proximos dias para ofrecer alternativas.
      const alternatives: string[] = [];
      if (main.status === "full" || main.status === "too_soon") {
        for (let i = 1; i <= 7 && alternatives.length < 3; i++) {
          const d = addDays(day, i);
          const r = await daySlots(tx, env, { date: d, timeZone: ctx.tenant.timezone, party: args.personas, now: ctx.now });
          if (r.status === "ok") alternatives.push(`${dayName(d)} ${d.day} (${dateKey(d)})`);
        }
      }
      return { main, alternatives, max: env.settings.reservationsMaxParty };
    });

    if (!found) return NOT_AVAILABLE;
    if ("noHours" in found) return { error: "horario_no_configurado", instruccion: "El restaurante todavía no tiene su horario cargado, así que no puedes reservar. Díselo y usa escalar_a_humano para que una persona lo atienda." };
    if (found.main.status !== "ok") {
      return { ...whyNot(found.main.status, args.personas, found.max), ...(found.alternatives.length > 0 ? { dias_con_lugar: found.alternatives } : {}) };
    }
    const picked = pickSlots(found.main.slots, args.hora_preferida ? timeLabel(args.hora_preferida) : null, 4);
    const wanted = args.hora_preferida ? timeLabel(args.hora_preferida) : null;
    return {
      fecha: `${dayName(day)} ${day.day}`,
      personas: args.personas,
      ...(wanted ? { hora_pedida_disponible: found.main.slots.some((s) => s.label === wanted) } : {}),
      horas_disponibles: picked.map((s) => s.label),
      instruccion: "Ofrece solo estas horas (di la hora en formato natural). Cuando el cliente elija una, usa crear_reservacion: primero sin confirmado para el resumen.",
    };
  },
});

const crearReservacion = defineModuleTool({
  name: "crear_reservacion",
  description:
    "Reserva mesa. Primero llámala SIN confirmado para obtener el resumen que debes repetir al cliente; solo cuando el cliente confirme, llámala de nuevo con los mismos datos y confirmado=true. Requiere el nombre y el teléfono del cliente ya guardados y una hora que devolvió buscar_mesa.",
  mutating: true,
  schema: z.object({ fecha, hora, personas, notas: z.string().trim().max(200).optional().describe("Algo especial: cumpleaños, silla para bebé, terraza… con las palabras del cliente."), confirmado }),
  async execute(args, ctx) {
    const day = parseDateKey(args.fecha);
    if (!day) return { error: "fecha_invalida", instruccion: "Usa el formato AAAA-MM-DD." };
    if (!validHour(args.hora)) return { error: "hora_invalida", instruccion: "Usa el formato HH:MM de 24 horas." };
    const label = timeLabel(args.hora);

    const env = await withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => {
      const e = await loadReservationEnv(tx);
      return { e, day: e.settings.reservationsEnabled && e.hours.length > 0 ? await daySlots(tx, e, { date: day, timeZone: ctx.tenant.timezone, party: args.personas, now: ctx.now }) : null };
    });
    if (!env.e.settings.reservationsEnabled) return NOT_AVAILABLE;
    if (!env.day) return { error: "horario_no_configurado", instruccion: "El restaurante todavía no tiene su horario cargado. Díselo y usa escalar_a_humano." };
    if (env.day.status !== "ok") return whyNot(env.day.status, args.personas, env.e.settings.reservationsMaxParty);
    const slot = env.day.slots.find((s) => s.label === label);
    if (!slot) {
      return { error: "hora_no_disponible", horas_disponibles: pickSlots(env.day.slots, label, 4).map((s) => s.label), instruccion: "Esa hora ya no está disponible (o no es una hora de reservación). Ofrécele estas horas." };
    }

    const name = ctx.contact.displayName?.trim();
    if (!name) return { error: "faltan_datos", faltan: ["nombre"], instruccion: "Pide el nombre del cliente (para la reservación) y guárdalo con guardar_datos_contacto antes de crearla." };
    if (!ctx.contact.phoneE164) {
      return { error: "faltan_datos", faltan: ["teléfono a 10 dígitos"], instruccion: "Antes de crear la reservación pídele su número de teléfono a 10 dígitos (si es por llamada, número por número, y repítelo) y guárdalo con guardar_datos_contacto (campo telefono)." };
    }

    const notes = args.notas?.trim() || null;
    const stay = env.e.settings.reservationsStayMinutes;
    const summary = `Reservación para ${args.personas} ${args.personas === 1 ? "persona" : "personas"} el ${formatWhen(slot.startsAt, ctx.tenant.timezone)}, a nombre de ${name}.${notes ? ` Nota: ${notes}.` : ""} Se les guarda la mesa unos ${stay} minutos.`;
    const stable = { fecha: dateKey(day), hora: label, personas: args.personas, notas: notes ?? "" };
    const gate = confirmationGate(ctx, "crear_reservacion", stable, args.confirmado, summary);
    if (gate) return gate;
    if (ctx.mode === "dry") return proposeAction(ctx, { tool: "crear_reservacion", args: stable, summary });

    const created = await withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => {
      const channel = await conversationChannel(tx, ctx.conversationId);
      const r = await reserveSeats(
        tx,
        {
          tenantId: ctx.tenantId,
          contactId: ctx.contactId,
          conversationId: ctx.conversationId,
          channel,
          customerName: name,
          customerPhone: ctx.contact.phoneE164,
          partySize: args.personas,
          startsAt: slot.startsAt,
          notes,
          createdBy: "bot",
          idempotencyKey: null,
          now: ctx.now,
        },
        env.e.settings,
      );
      if (r.ok && !r.duplicate) {
        await tx.insert(auditLog).values({ tenantId: ctx.tenantId, action: "reservation.created", entity: "reservation", entityId: r.reservation.id, diff: { actor: ctx.skipConfirmation ? "bot_aprobado_por_humano" : "bot", number: r.reservation.number, partySize: args.personas, channel } });
      }
      return r;
    });
    if (!created.ok) {
      return { error: "hora_no_disponible", instruccion: "Justo ahora se ocupó ese lugar. Vuelve a buscar con buscar_mesa y ofrécele otras horas." };
    }
    finishMutation(ctx);
    return {
      ok: true,
      reservacion_numero: created.reservation.number,
      personas: created.reservation.partySize,
      cuando: formatWhen(created.reservation.startsAt, ctx.tenant.timezone),
      ...(created.duplicate ? { nota: "Ya tenía esta reservación; no se duplicó." } : {}),
      confirmacion: summary,
      instruccion: "Dile su NÚMERO DE RESERVACIÓN, el día, la hora y las personas. Pídele que avise si no va a poder llegar.",
    };
  },
});

const misReservaciones = defineModuleTool({
  name: "mis_reservaciones",
  description: "Consulta las reservaciones próximas del cliente que escribe. Úsala para '¿tengo reservación?' y antes de cancelar.",
  mutating: false,
  schema: z.object({}),
  async execute(_args, ctx) {
    const rows = await withTenant(ctx.db, { tenantId: ctx.tenantId }, (tx) =>
      tx
        .select()
        .from(reservations)
        .where(and(eq(reservations.contactId, ctx.contactId), inArray(reservations.status, [...OCCUPYING]), gte(reservations.endsAt, ctx.now)))
        .orderBy(asc(reservations.startsAt))
        .limit(5),
    );
    if (rows.length === 0) return { reservaciones: [], instruccion: "El cliente no tiene reservaciones próximas. Dilo y ofrece reservar." };
    return {
      reservaciones: rows.map((r) => ({ reservacion_numero: r.number, personas: r.partySize, cuando: formatLocal(r.startsAt, ctx.tenant.timezone), ...(r.notes ? { nota: r.notes } : {}) })),
      instruccion: "Responde solo con estas reservaciones.",
    };
  },
});

const cancelarReservacion = defineModuleTool({
  name: "cancelar_reservacion",
  description: "Cancela una reservación del cliente que todavía no ha llegado su hora. Primero llámala SIN confirmado para el resumen; solo cuando el cliente confirme, vuelve a llamarla con confirmado=true.",
  mutating: true,
  schema: z.object({ reservacion_numero: z.number().int().positive().describe("El número de reservación que se le dio al cliente"), confirmado }),
  async execute(args, ctx) {
    const row = await withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => {
      const [r] = await tx.select().from(reservations).where(and(eq(reservations.number, args.reservacion_numero), eq(reservations.contactId, ctx.contactId)));
      return r ?? null;
    });
    if (!row) return { error: "reservacion_no_encontrada", instruccion: "No hay una reservación con ese número a nombre de este cliente. Revisa con mis_reservaciones." };
    if (row.status !== "confirmed") return { error: "reservacion_cerrada", instruccion: `La reservación #${row.number} ya no se puede cancelar por aquí (está ${row.status === "cancelled" ? "cancelada" : "cerrada"}).` };
    if (row.startsAt.getTime() <= ctx.now.getTime()) return { error: "reservacion_pasada", instruccion: "Esa reservación ya empezó. Si hay algún problema, pásalo con una persona usando escalar_a_humano." };

    const summary = `Cancelar la reservación #${row.number} para ${row.partySize} ${row.partySize === 1 ? "persona" : "personas"} el ${formatWhen(row.startsAt, ctx.tenant.timezone)}.`;
    const gate = confirmationGate(ctx, "cancelar_reservacion", { reservacion_numero: row.number }, args.confirmado, summary);
    if (gate) return gate;
    if (ctx.mode === "dry") return proposeAction(ctx, { tool: "cancelar_reservacion", args: { reservacion_numero: row.number }, summary });

    const done = await withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => {
      const changed = await tx
        .update(reservations)
        .set({ status: "cancelled", cancelledAt: ctx.now, cancelledBy: "cliente", cancelReason: "Lo canceló el cliente", updatedAt: ctx.now })
        .where(and(eq(reservations.id, row.id), eq(reservations.status, "confirmed")))
        .returning({ id: reservations.id });
      if (changed.length === 0) return false;
      await tx.insert(auditLog).values({ tenantId: ctx.tenantId, action: "reservation.cancelled", entity: "reservation", entityId: row.id, diff: { number: row.number, by: "cliente" } });
      return true;
    });
    if (!done) return { error: "reservacion_cerrada", instruccion: "Esa reservación ya cambió de estado. Revisa con mis_reservaciones." };
    finishMutation(ctx);
    return { ok: true, reservacion_numero: row.number, confirmacion: `La reservación #${row.number} quedó cancelada.` };
  },
});

export const RESERVATION_TOOLS = [buscarMesa, crearReservacion, misReservaciones, cancelarReservacion];
