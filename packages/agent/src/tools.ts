import {
  appointments,
  auditLog,
  businessHolidays,
  businessHours,
  contacts,
  conversations,
  handoffs,
  knowledgeDocs,
  messages,
  services,
  staff,
  staffServices,
  tenants,
  withTenant,
  type ProposedAction,
  type Service,
  type Tx,
} from "@empleado/db";
import type { ToolDefinition } from "@empleado/llm";
import {
  addDays,
  busyInterval,
  computeAvailability,
  localDate,
  localParts,
  parseHM,
  pickOptions,
  type Slot,
  type TimeWindow,
} from "@empleado/scheduling";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import {
  formatLocal,
  formatMoney,
  parseDateKey,
  startOfLocalDay,
  weekdayName,
} from "./format";
import { humanAvailability } from "./humanhours";
import { searchKnowledge } from "./knowledge-search";
import type { PendingAction, ToolResult, TurnContext } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 30 * 60 * 1000;
const ACTIVE_STATUSES = ["pending", "confirmed"] as const;

// ---------------------------------------------------------------- utilidades

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code;
}

const toWindow = (h: { weekday: number; opens: string; closes: string }): TimeWindow => ({
  weekday: h.weekday,
  opens: h.opens,
  closes: h.closes,
});

/** Huella estable de los argumentos (sin "confirmado") para ligar la confirmacion a la accion. */
function actionKey(tool: string, args: Record<string, unknown>): string {
  const entries = Object.entries(args)
    .filter(([k, v]) => k !== "confirmado" && v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([tool, entries]);
}

/**
 * Confirmacion obligatoria, impuesta por codigo y no solo por el prompt:
 *  - la primera llamada solo devuelve el resumen y deja la accion "pendiente";
 *  - la ejecucion exige la MISMA accion, confirmado=true y que la confirmacion llegue en
 *    un mensaje posterior del cliente (no en el mismo turno en que se propuso).
 * Devuelve un resultado para el modelo si todavia NO se puede ejecutar, o null si procede.
 */
function confirmationGate(
  ctx: TurnContext,
  tool: string,
  args: Record<string, unknown>,
  confirmado: boolean,
  summary: string,
): ToolResult | null {
  if (ctx.skipConfirmation) return null;

  const key = actionKey(tool, args);
  const pending = ctx.taskState.pendingAction;
  const fresh =
    pending !== undefined &&
    ctx.now.getTime() - new Date(pending.createdAt).getTime() < PENDING_TTL_MS;

  if (confirmado && pending && fresh && pending.tool === tool && pending.key === key) {
    if (pending.inboundCount < ctx.inboundCount) return null; // el cliente respondio despues
    return {
      error: "falta_confirmacion",
      instruccion:
        "Todavía no puedes ejecutarla: el cliente aún no responde a tu resumen. Repite el resumen y espera su respuesta en el siguiente mensaje.",
    };
  }

  const next: PendingAction = {
    tool,
    key,
    inboundCount: ctx.inboundCount,
    createdAt: ctx.now.toISOString(),
  };
  ctx.taskState.pendingAction = next;
  return {
    requiere_confirmacion: true,
    resumen: summary,
    instruccion:
      "Repite este resumen al cliente y pregúntale si confirma. Solo cuando responda que sí, en su SIGUIENTE mensaje, vuelve a llamar esta herramienta con los mismos argumentos y confirmado=true.",
    ...(confirmado ? { aviso: "No había una propuesta previa vigente para esta acción; se generó una nueva." } : {}),
  };
}

function finishMutation(ctx: TurnContext): void {
  delete ctx.taskState.pendingAction;
  ctx.usedMutation = true;
}

/** En modo "dry" registra la propuesta en vez de escribir. */
function proposeAction(ctx: TurnContext, action: ProposedAction): ToolResult {
  ctx.proposedActions.push(action);
  finishMutation(ctx);
  return {
    ok: true,
    estado: "pendiente_aprobacion",
    resumen: action.summary,
    instruccion:
      "La acción AÚN NO está hecha: queda pendiente de que el equipo la apruebe. Dile al cliente que registraste su solicitud y que el equipo se la confirma en breve.",
  };
}

async function audit(tx: Tx, ctx: TurnContext, action: string, entityId: string, diff: unknown) {
  await tx.insert(auditLog).values({
    tenantId: ctx.tenantId,
    action,
    entity: "appointment",
    entityId,
    diff: { actor: ctx.skipConfirmation ? "bot_aprobado_por_humano" : "bot", ...(diff as object) },
  });
}

interface AvailabilityQuery {
  serviceId: string;
  staffId?: string;
  from: Date;
  to: Date;
  excludeAppointmentId?: string;
}

type StaffRow = { id: string; name: string };
type Gathered =
  | { ok: false; error: "servicio_no_encontrado" | "empleado_no_disponible" }
  | { ok: true; service: Service; staffRows: StaffRow[]; slots: Slot[] };
type SlotCheck =
  | { ok: false; error: string }
  | { ok: true; free: boolean; service: Service; staffRows: StaffRow[] };

/** Lo unico que hace falta del turno para calcular disponibilidad (asi tambien lo usa el panel). */
type ClockCtx = { now: Date; tenant: { timezone: string } };

async function gatherAvailability(tx: Tx, ctx: ClockCtx, q: AvailabilityQuery): Promise<Gathered> {
  const [service] = await tx
    .select()
    .from(services)
    .where(and(eq(services.id, q.serviceId), eq(services.active, true)));
  if (!service) return { ok: false, error: "servicio_no_encontrado" };

  const staffRows = await tx
    .select({ id: staff.id, name: staff.name })
    .from(staffServices)
    .innerJoin(staff, eq(staff.id, staffServices.staffId))
    .where(
      and(
        eq(staffServices.serviceId, q.serviceId),
        eq(staff.active, true),
        q.staffId ? eq(staff.id, q.staffId) : undefined,
      ),
    );
  if (staffRows.length === 0) return { ok: false, error: "empleado_no_disponible" };

  const ids = staffRows.map((s) => s.id);
  const [hours, holidays, busyRows] = await Promise.all([
    tx.select().from(businessHours),
    tx.select().from(businessHolidays),
    tx
      .select({
        id: appointments.id,
        staffId: appointments.staffId,
        startsAt: appointments.startsAt,
        endsAt: appointments.endsAt,
        buffer: services.bufferMin,
      })
      .from(appointments)
      .innerJoin(services, eq(services.id, appointments.serviceId))
      .where(
        and(
          inArray(appointments.staffId, ids),
          inArray(appointments.status, [...ACTIVE_STATUSES]),
          lt(appointments.startsAt, new Date(q.to.getTime() + DAY_MS)),
          gt(appointments.endsAt, new Date(q.from.getTime() - DAY_MS)),
        ),
      ),
  ]);

  const slots = computeAvailability({
    timezone: ctx.tenant.timezone,
    from: q.from,
    to: q.to,
    now: ctx.now,
    service: { durationMin: service.durationMin, bufferMin: service.bufferMin },
    businessHours: hours.filter((h) => !h.staffId).map(toWindow),
    businessHolidays: holidays.filter((h) => !h.staffId).map((h) => h.date),
    staff: staffRows.map((s) => ({
      staffId: s.id,
      hours: hours.filter((h) => h.staffId === s.id).map(toWindow),
      holidays: holidays.filter((h) => h.staffId === s.id).map((h) => h.date),
      busy: busyRows
        .filter((b) => b.staffId === s.id && b.id !== q.excludeAppointmentId)
        .map((b) => busyInterval(b.startsAt, b.endsAt, b.buffer)),
    })),
  });
  return { ok: true, service, staffRows, slots };
}

/** Comprueba que EXACTAMENTE ese horario siga libre para ese empleado. */
async function slotIsFree(
  tx: Tx,
  ctx: ClockCtx,
  q: { serviceId: string; staffId: string; start: Date; excludeAppointmentId?: string },
): Promise<SlotCheck> {
  const found = await gatherAvailability(tx, ctx, {
    serviceId: q.serviceId,
    staffId: q.staffId,
    from: q.start,
    to: new Date(q.start.getTime() + 60_000),
    excludeAppointmentId: q.excludeAppointmentId,
  });
  if (!found.ok) return { ok: false, error: found.error };
  const slot: Slot | undefined = found.slots.find(
    (s) => s.staffId === q.staffId && s.start.getTime() === q.start.getTime(),
  );
  return { ok: true, service: found.service, staffRows: found.staffRows, free: Boolean(slot) };
}

const NOT_FREE: ToolResult = {
  error: "horario_no_disponible",
  instruccion:
    "Ese horario ya no está libre o no es válido. Llama buscar_disponibilidad y ofrece otras opciones al cliente.",
};

// ------------------------------------------------------------------ esquemas

const id = z.uuid();
const isoInstant = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Fecha ISO invalida");
const confirmado = z
  .boolean()
  .optional()
  .default(false)
  .describe("false/omitido para obtener el resumen; true SOLO después de que el cliente confirmó");

const hhmm = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Usa el formato HH:MM");

const noArgs = z.object({});

const schemas = {
  consultar_servicios: noArgs,
  consultar_horario: noArgs,
  buscar_disponibilidad: z.object({
    servicio_id: id.describe("ID del servicio (de consultar_servicios)"),
    empleado_id: id.optional().describe("Solo si el cliente pidió un especialista en concreto"),
    desde: z.string().optional().describe("Fecha local AAAA-MM-DD desde la cual buscar; por defecto hoy"),
    dias: z.number().int().min(1).max(30).optional().describe("Cuántos días buscar (1 si pidió un día específico). Por defecto 14"),
    max_opciones: z.number().int().min(1).max(6).optional().describe("Por defecto 3"),
    hora_desde: hhmm.optional().describe("Solo horarios que empiecen a esta hora local o después (HH:MM). Para 'por la tarde' usa 12:00; para 'después de las 5' usa 17:00"),
    hora_hasta: hhmm.optional().describe("Solo horarios que empiecen ANTES de esta hora local (HH:MM). Para 'por la mañana' usa hora_hasta 12:00"),
  }),
  crear_cita: z.object({
    servicio_id: id,
    empleado_id: id,
    inicio_iso: isoInstant.describe("El inicio_iso EXACTO que devolvió buscar_disponibilidad"),
    confirmado,
  }),
  buscar_citas_del_contacto: noArgs,
  reprogramar_cita: z.object({ cita_id: id, nuevo_inicio_iso: isoInstant, confirmado }),
  cancelar_cita: z.object({ cita_id: id, confirmado }),
  guardar_datos_contacto: z.object({
    nombre: z.string().trim().min(2).max(120).optional().describe("Nombre completo"),
    correo: z.string().trim().email().max(160).optional(),
    telefono: z.string().trim().min(8).max(20).optional().describe("Teléfono de WhatsApp del cliente (10 dígitos en México)"),
    datos: z
      .record(z.string().max(40), z.string().max(200))
      .optional()
      .describe("Otros datos útiles y durables, por ejemplo {seguro_dental: 'GNP'}"),
  }),
  buscar_conocimiento: z.object({ pregunta: z.string().trim().min(3).max(300) }),
  enviar_ubicacion: noArgs,
  escalar_a_humano: z.object({
    motivo: z
      .string()
      .trim()
      .min(3)
      .max(300)
      .describe("POR QUÉ escalas, concreto: qué no pudiste hacer o qué dato falta (p. ej. 'no hay servicios cargados', 'el cliente pidió hablar con una persona'). Nunca algo genérico."),
    resumen: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .optional()
      .describe("Contexto para la persona que tomará la conversación: qué quiere el cliente, qué datos ya dio y qué ya hiciste. 1 a 3 frases."),
    urgencia: z.enum(["normal", "alta"]).default("normal"),
  }),
} as const;

type Schemas = typeof schemas;
type ToolName = keyof Schemas;

interface ToolSpec<N extends ToolName> {
  name: N;
  description: string;
  /** Modifica datos del negocio: pasa por la politica de aprobacion. */
  mutating: boolean;
  execute: (args: z.output<Schemas[N]>, ctx: TurnContext) => Promise<ToolResult>;
}

type ToolTable = { [N in ToolName]: ToolSpec<N> };

// ----------------------------------------------------------------- herramientas

/** "998 123 4567" / "+52 1 998..." -> "+529981234567"; null si no parece un telefono mexicano valido. */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("521")) d = d.slice(3);
  else if (d.length === 12 && d.startsWith("52")) d = d.slice(2);
  return d.length === 10 ? `+52${d}` : null;
}

export const TOOLS: ToolTable = {
  consultar_servicios: {
    name: "consultar_servicios",
    description:
      "Lista los servicios del negocio con precio, duración y qué especialistas los realizan. Úsala para cualquier pregunta de precios o servicios.",
    mutating: false,
    async execute(_args, ctx) {
      const { rows, links } = await withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => ({
        rows: await tx.select().from(services).where(eq(services.active, true)).orderBy(asc(services.name)),
        links: await tx
          .select({ serviceId: staffServices.serviceId, id: staff.id, name: staff.name })
          .from(staffServices)
          .innerJoin(staff, eq(staff.id, staffServices.staffId))
          .where(eq(staff.active, true)),
      }));
      return {
        servicios: rows.map((s) => ({
          id: s.id,
          nombre: s.name,
          descripcion: s.description,
          duracion_min: s.durationMin,
          precio: formatMoney(s.priceCents, s.currency),
          requiere_anticipo: s.requiresDeposit,
          atiende: links.filter((l) => l.serviceId === s.id).map((l) => ({ id: l.id, nombre: l.name })),
        })),
      };
    },
  },

  consultar_horario: {
    name: "consultar_horario",
    description:
      "Devuelve los horarios de atención del negocio, los horarios propios de cada especialista y los próximos días festivos.",
    mutating: false,
    async execute(_args, ctx) {
      const tz = ctx.tenant.timezone;
      const today = localDate(ctx.now, tz);
      const limit = addDays(today, 60);
      const { hours, staffRows, holidays } = await withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => ({
        hours: await tx.select().from(businessHours).orderBy(asc(businessHours.weekday), asc(businessHours.opens)),
        staffRows: await tx.select({ id: staff.id, name: staff.name }).from(staff).where(eq(staff.active, true)),
        holidays: await tx.select().from(businessHolidays).orderBy(asc(businessHolidays.date)),
      }));
      const order = [1, 2, 3, 4, 5, 6, 0];
      const describe = (rows: typeof hours) =>
        order
          .map((wd) => {
            const day = rows.filter((h) => h.weekday === wd);
            return day.length
              ? `${weekdayName(wd)} ${day.map((h) => `${h.opens.slice(0, 5)}-${h.closes.slice(0, 5)}`).join(" y ")}`
              : null;
          })
          .filter(Boolean);
      const key = (d: { year: number; month: number; day: number }) =>
        `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
      return {
        horario_del_negocio: describe(hours.filter((h) => !h.staffId)),
        horario_propio_de_especialistas: staffRows
          .map((s) => ({ nombre: s.name, horario: describe(hours.filter((h) => h.staffId === s.id)) }))
          .filter((s) => s.horario.length > 0),
        proximos_festivos: holidays
          .filter((h) => h.date >= key(today) && h.date <= key(limit))
          .map((h) => ({ fecha: h.date, motivo: h.reason })),
      };
    },
  },

  buscar_disponibilidad: {
    name: "buscar_disponibilidad",
    description:
      "Busca horarios REALMENTE libres para un servicio (considera horario, festivos y citas existentes). Devuelve pocas opciones concretas para ofrecer al cliente. Es la única fuente válida de disponibilidad.",
    mutating: false,
    async execute(args, ctx) {
      const tz = ctx.tenant.timezone;
      const startDay = args.desde ? parseDateKey(args.desde) : localDate(ctx.now, tz);
      if (!startDay) return { error: "fecha_invalida", instruccion: "Usa el formato AAAA-MM-DD." };
      const days = args.dias ?? 14;
      const from = startOfLocalDay(startDay, tz);
      const to = startOfLocalDay(addDays(startDay, days), tz);

      const found = await withTenant(ctx.db, { tenantId: ctx.tenantId }, (tx) =>
        gatherAvailability(tx, ctx, { serviceId: args.servicio_id, staffId: args.empleado_id, from, to }),
      );
      if (!found.ok) return { error: found.error };

      const names = new Map(found.staffRows.map((s) => [s.id, s.name]));
      const max = args.max_opciones ?? 3;
      const present = (list: Slot[]) =>
        list.map((o) => ({
          inicio_iso: o.start.toISOString(),
          cuando: formatLocal(o.start, tz),
          empleado_id: o.staffId,
          con: names.get(o.staffId),
        }));

      // Filtro por franja horaria LOCAL ("por la tarde"): lo hace el codigo, no el modelo,
      // para que nunca afirme "no hay por la tarde" solo porque vio las primeras opciones.
      const minutesOf = (d: Date) => {
        const p = localParts(d, tz);
        return p.hour * 60 + p.minute;
      };
      const from_ = args.hora_desde ? parseHM(args.hora_desde) : 0;
      const until = args.hora_hasta ? parseHM(args.hora_hasta) : 24 * 60;
      const filtered = found.slots.filter((s) => minutesOf(s.start) >= from_ && minutesOf(s.start) < until);
      const hasFilter = Boolean(args.hora_desde || args.hora_hasta);

      const options = pickOptions(filtered, tz, max);
      if (options.length === 0) {
        const elsewhere = hasFilter ? pickOptions(found.slots, tz, max) : [];
        return {
          sin_disponibilidad: true,
          servicio: found.service.name,
          ...(elsewhere.length > 0
            ? {
                sin_disponibilidad_en_esa_franja: true,
                opciones_en_otros_horarios: present(elsewhere),
                instruccion:
                  "No hay horarios en la franja que pidió el cliente, pero sí en otros. Díselo con honestidad y ofrece estas.",
              }
            : {
                instruccion:
                  "No hay horarios libres en ese rango. Ofrece buscar en otras fechas; si el cliente insiste o es urgente, usa escalar_a_humano.",
              }),
        };
      }
      return {
        servicio: found.service.name,
        duracion_min: found.service.durationMin,
        ...(hasFilter ? { franja_aplicada: `${args.hora_desde ?? "00:00"} a ${args.hora_hasta ?? "24:00"}` } : {}),
        opciones: present(options),
      };
    },
  },

  crear_cita: {
    name: "crear_cita",
    description:
      "Agenda una cita. Primero llámala SIN confirmado para obtener el resumen que debes repetir al cliente; solo cuando el cliente confirme, llámala de nuevo con confirmado=true. Requiere que el nombre del cliente ya esté guardado.",
    mutating: true,
    async execute(args, ctx) {
      const name = ctx.contact.displayName?.trim();
      if (!name) {
        return {
          error: "faltan_datos",
          faltan: ["nombre completo"],
          instruccion: "Pide el nombre completo del cliente y guárdalo con guardar_datos_contacto antes de agendar.",
        };
      }
      const tz = ctx.tenant.timezone;
      const start = new Date(args.inicio_iso);

      const check = await withTenant(ctx.db, { tenantId: ctx.tenantId }, (tx) =>
        slotIsFree(tx, ctx, { serviceId: args.servicio_id, staffId: args.empleado_id, start }),
      );
      if (!check.ok) return { error: check.error };
      if (!check.free) return NOT_FREE;

      const staffName = check.staffRows.find((s) => s.id === args.empleado_id)?.name ?? "el equipo";
      const service = check.service;
      const summary =
        `Cita de ${service.name} con ${staffName}, ${formatLocal(start, tz)} ` +
        `(${service.durationMin} min), costo ${formatMoney(service.priceCents, service.currency)}` +
        (service.requiresDeposit ? `, requiere anticipo` : "") +
        `, a nombre de ${name}.`;

      const gate = confirmationGate(
        ctx,
        "crear_cita",
        { servicio_id: args.servicio_id, empleado_id: args.empleado_id, inicio_iso: start.toISOString() },
        args.confirmado,
        summary,
      );
      if (gate) return gate;

      if (ctx.mode === "dry") {
        return proposeAction(ctx, {
          tool: "crear_cita",
          args: { servicio_id: args.servicio_id, empleado_id: args.empleado_id, inicio_iso: start.toISOString() },
          summary,
        });
      }

      try {
        const created = await withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => {
          const [row] = await tx
            .insert(appointments)
            .values({
              tenantId: ctx.tenantId,
              contactId: ctx.contactId,
              serviceId: service.id,
              staffId: args.empleado_id,
              startsAt: start,
              endsAt: new Date(start.getTime() + service.durationMin * 60_000),
              status: "confirmed",
              sourceConversationId: ctx.conversationId,
            })
            .returning();
          await audit(tx, ctx, "appointment.created", row!.id, { start: start.toISOString(), service: service.name });
          return row!;
        });
        finishMutation(ctx);
        return {
          ok: true,
          cita_id: created.id,
          confirmacion: summary,
          ...(service.requiresDeposit
            ? { nota: "Este servicio requiere anticipo: avisa que el equipo le enviará los datos para apartarlo." }
            : {}),
        };
      } catch (e) {
        if (pgCode(e) === "23P01") return NOT_FREE; // alguien lo tomo justo antes
        throw e;
      }
    },
  },

  buscar_citas_del_contacto: {
    name: "buscar_citas_del_contacto",
    description: "Lista las citas próximas del cliente que está escribiendo. Úsala para '¿cuándo es mi cita?' o antes de cambiar/cancelar.",
    mutating: false,
    async execute(_args, ctx) {
      const rows = await upcomingAppointments(ctx);
      return {
        citas: rows.map((r) => ({
          cita_id: r.id,
          servicio: r.service,
          con: r.staff,
          cuando: formatLocal(r.startsAt, ctx.tenant.timezone),
          estado: r.status,
        })),
        total: rows.length,
      };
    },
  },

  reprogramar_cita: {
    name: "reprogramar_cita",
    description:
      "Cambia la fecha/hora de una cita del cliente. Mismo flujo que crear_cita: primero sin confirmado para el resumen, luego con confirmado=true cuando el cliente acepte.",
    mutating: true,
    async execute(args, ctx) {
      const appt = await ownAppointment(ctx, args.cita_id);
      if (!appt) return { error: "cita_no_encontrada" };
      const blocked = policyBlock(ctx, appt.startsAt);
      if (blocked) return blocked;

      const tz = ctx.tenant.timezone;
      const start = new Date(args.nuevo_inicio_iso);
      const check = await withTenant(ctx.db, { tenantId: ctx.tenantId }, (tx) =>
        slotIsFree(tx, ctx, {
          serviceId: appt.serviceId,
          staffId: appt.staffId,
          start,
          excludeAppointmentId: appt.id,
        }),
      );
      if (!check.ok) return { error: check.error };
      if (!check.free) return NOT_FREE;

      const summary =
        `Cambiar la cita de ${appt.serviceName} con ${appt.staffName}: de ${formatLocal(appt.startsAt, tz)} ` +
        `a ${formatLocal(start, tz)}.`;
      const gate = confirmationGate(
        ctx,
        "reprogramar_cita",
        { cita_id: appt.id, nuevo_inicio_iso: start.toISOString() },
        args.confirmado,
        summary,
      );
      if (gate) return gate;

      if (ctx.mode === "dry") {
        return proposeAction(ctx, {
          tool: "reprogramar_cita",
          args: { cita_id: appt.id, nuevo_inicio_iso: start.toISOString() },
          summary,
        });
      }

      try {
        await withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => {
          await tx
            .update(appointments)
            .set({
              startsAt: start,
              endsAt: new Date(start.getTime() + appt.durationMin * 60_000),
              status: "confirmed",
              confirmedByContact: false,
              reminder24hSentAt: null,
              reminder2hSentAt: null,
              updatedAt: new Date(),
            })
            .where(eq(appointments.id, appt.id));
          await audit(tx, ctx, "appointment.rescheduled", appt.id, {
            from: appt.startsAt.toISOString(),
            to: start.toISOString(),
          });
        });
        finishMutation(ctx);
        return { ok: true, cita_id: appt.id, confirmacion: summary };
      } catch (e) {
        if (pgCode(e) === "23P01") return NOT_FREE;
        throw e;
      }
    },
  },

  cancelar_cita: {
    name: "cancelar_cita",
    description:
      "Cancela una cita del cliente. Mismo flujo de confirmación que crear_cita. Respeta la política de cancelación del negocio.",
    mutating: true,
    async execute(args, ctx) {
      const appt = await ownAppointment(ctx, args.cita_id);
      if (!appt) return { error: "cita_no_encontrada" };
      const blocked = policyBlock(ctx, appt.startsAt);
      if (blocked) return blocked;

      const summary = `Cancelar la cita de ${appt.serviceName} con ${appt.staffName}, ${formatLocal(appt.startsAt, ctx.tenant.timezone)}.`;
      const gate = confirmationGate(ctx, "cancelar_cita", { cita_id: appt.id }, args.confirmado, summary);
      if (gate) return gate;

      if (ctx.mode === "dry") {
        return proposeAction(ctx, { tool: "cancelar_cita", args: { cita_id: appt.id }, summary });
      }
      await withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => {
        await tx
          .update(appointments)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(eq(appointments.id, appt.id));
        await audit(tx, ctx, "appointment.cancelled", appt.id, { was: appt.startsAt.toISOString() });
      });
      finishMutation(ctx);
      return { ok: true, cita_id: appt.id, confirmacion: summary };
    },
  },

  guardar_datos_contacto: {
    name: "guardar_datos_contacto",
    description:
      "Guarda datos que el cliente te dio: nombre completo, correo u otros datos durables (seguro, preferencias). Úsala en cuanto los tengas.",
    mutating: false,
    async execute(args, ctx) {
      if (!args.nombre && !args.correo && !args.datos && !args.telefono) return { error: "nada_que_guardar" };
      let phone: string | undefined;
      if (args.telefono) {
        phone = normalizePhone(args.telefono) ?? undefined;
        if (!phone) return { error: "telefono_invalido", detalle: "Pide el número a 10 dígitos (lada + número)." };
        if (ctx.contact.phoneE164 && ctx.contact.phoneE164 !== phone) return { error: "telefono_ya_registrado", detalle: "Este cliente ya tiene otro teléfono guardado; un humano debe cambiarlo." };
      }
      const updated = await withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => {
        const profile = { ...(ctx.contact.profile ?? {}) } as Record<string, unknown>;
        for (const [k, v] of Object.entries(args.datos ?? {})) {
          if (Object.keys(profile).length >= 30 && !(k in profile)) break; // tope anti-abuso
          profile[k.toLowerCase().replace(/[^a-z0-9_]+/g, "_")] = v;
        }
        const [row] = await tx
          .update(contacts)
          .set({
            ...(args.nombre ? { displayName: args.nombre } : {}),
            ...(args.correo ? { email: args.correo } : {}),
            ...(phone ? { phoneE164: phone } : {}),
            profile,
            updatedAt: new Date(),
          })
          .where(eq(contacts.id, ctx.contactId))
          .returning();
        return row!;
      }).catch((error: unknown) => {
        // Indice unico (negocio, telefono): ese numero ya es de OTRO contacto. NO se fusionan
        // historiales: quien escribe por Instagram no debe heredar los datos de otra persona.
        const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
        if (code === "23505" && phone) return "telefono_en_uso" as const;
        throw error;
      });
      if (updated === "telefono_en_uso") {
        return { error: "telefono_en_uso", detalle: "Ese número ya está asociado a otro cliente. Dile que un asesor lo revisará y usa escalar_a_humano." };
      }
      ctx.contact = updated; // las siguientes herramientas del turno ya ven el nombre
      return { ok: true, nombre: updated.displayName, correo: updated.email, telefono: updated.phoneE164 };
    },
  },

  buscar_conocimiento: {
    name: "buscar_conocimiento",
    description:
      "Busca en los documentos y preguntas frecuentes del negocio (políticas, cuidados, formas de pago...). Si devuelve encontrado=false NO inventes: escala a un humano.",
    mutating: false,
    async execute(args, ctx) {
      const docs = await withTenant(ctx.db, { tenantId: ctx.tenantId }, (tx) =>
        tx.select({ title: knowledgeDocs.title, text: knowledgeDocs.rawText }).from(knowledgeDocs),
      );
      const hits = searchKnowledge(
        args.pregunta,
        docs.filter((d) => d.text).map((d) => ({ title: d.title, text: d.text! })),
      );
      if (hits.length === 0) {
        return {
          encontrado: false,
          instruccion: "No hay información en los documentos del negocio. No inventes: dile al cliente que lo confirmas con el equipo y usa escalar_a_humano.",
        };
      }
      return { encontrado: true, resultados: hits };
    },
  },

  enviar_ubicacion: {
    name: "enviar_ubicacion",
    description: "Envía al cliente la ubicación del negocio (dirección y mapa).",
    mutating: false,
    async execute(_args, ctx) {
      const p = ctx.tenant.profile ?? {};
      if (!p.address && !p.mapsUrl) {
        return { error: "sin_ubicacion", instruccion: "El negocio no tiene ubicación registrada: escala a un humano." };
      }
      ctx.attachments.push({
        type: "location",
        name: ctx.tenant.name,
        address: p.address,
        latitude: p.latitude,
        longitude: p.longitude,
        mapsUrl: p.mapsUrl,
      });
      return { ok: true, direccion: p.address, mapa: p.mapsUrl };
    },
  },

  escalar_a_humano: {
    name: "escalar_a_humano",
    description:
      "Pasa la conversación a una persona del equipo y pausa al asistente. Úsala ante quejas, urgencias, descuentos, facturas, dudas que no puedas resolver con datos reales, o si el cliente lo pide.",
    mutating: false,
    async execute(args, ctx) {
      return recordEscalation(ctx, { motivo: args.motivo, resumen: args.resumen, urgencia: args.urgencia, source: "assistant" });
    },
  },
};

/** Lo ultimo que escribio el cliente, para dar contexto cuando el asistente no redacto un resumen. */
async function customerRecap(tx: Tx, conversationId: string): Promise<string | null> {
  const rows = await tx
    .select({ body: messages.body, transcript: messages.transcript })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, "in")))
    .orderBy(desc(messages.createdAt))
    .limit(4);
  const said = rows
    .reverse()
    .map((m) => (m.transcript ?? m.body ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((t) => `«${t.length > 140 ? `${t.slice(0, 137)}…` : t}»`);
  return said.length > 0 ? `El cliente escribió: ${said.join(" · ")}`.slice(0, 500) : null;
}

/**
 * Pasa la conversacion a una persona y deja constancia de POR QUE y de que quiere el cliente.
 * `source = system` es una falla tecnica del asistente (no una decision suya): se marca para que nadie la confunda.
 */
export async function recordEscalation(
  ctx: TurnContext,
  input: { motivo: string; resumen?: string; urgencia: "normal" | "alta"; source: "assistant" | "system" },
): Promise<ToolResult> {
  const availability = humanAvailability(ctx.tenant.humanHours, ctx.now, ctx.tenant.timezone);
  await withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => {
    const open = await tx
      .select({ id: handoffs.id })
      .from(handoffs)
      .where(and(eq(handoffs.conversationId, ctx.conversationId), isNull(handoffs.resolvedAt)));
    if (open.length === 0) {
      const summary = input.resumen?.trim() || (await customerRecap(tx, ctx.conversationId));
      await tx.insert(handoffs).values({
        tenantId: ctx.tenantId,
        conversationId: ctx.conversationId,
        reason: input.motivo,
        summary,
        source: input.source,
        urgency: input.urgencia,
        notifiedAt: null, // lo toma el servicio de notificaciones (paso de bandeja)
      });
    }
    await tx
      .update(conversations)
      .set({ state: "human", updatedAt: new Date() })
      .where(eq(conversations.id, ctx.conversationId));
  });
  ctx.escalated = true;
  const when = availability.openNow ? "en breve" : availability.nextOpenText ? `${availability.nextOpenText}` : "en cuanto sea posible";
  ctx.escalationMessage = availability.openNow
    ? "Le paso tu mensaje a la recepción y te contestan en breve."
    : `Le paso tu mensaje a la recepción; te contestan ${when}.`;
  return {
    ok: true,
    urgencia: input.urgencia,
    persona_disponible_ahora: availability.openNow,
    te_contestan: when,
    mensaje_sugerido: ctx.escalationMessage,
    instruccion: "Informa al cliente de forma honesta y breve; no sigas resolviendo el tema tú.",
  };
}

// ------------------------------------------- agendar a mano (desde el panel)

export type ManualSlot = { startIso: string; staffId: string; staffName: string };
export type ManualBookingError = "servicio_no_encontrado" | "empleado_no_disponible" | "fecha_invalida" | "horario_no_disponible" | "contacto_no_encontrado";

/**
 * Horarios libres para que una PERSONA agende (panel). Es la misma disponibilidad que usa el asistente
 * (horario, festivos, citas existentes, descansos), pero devuelve TODOS los horarios de los dias pedidos.
 */
export async function listFreeSlots(
  db: Parameters<typeof withTenant>[0],
  tenantId: string,
  q: { serviceId: string; staffId?: string; fromDay: string; days: number; now?: Date },
): Promise<{ ok: true; timezone: string; service: { id: string; name: string; durationMin: number }; slots: ManualSlot[] } | { ok: false; error: ManualBookingError }> {
  const day = parseDateKey(q.fromDay);
  if (!day) return { ok: false, error: "fecha_invalida" };
  const now = q.now ?? new Date();
  const days = Math.min(Math.max(Math.floor(q.days), 1), 31);

  return withTenant(db, { tenantId }, async (tx) => {
    const [tenant] = await tx.select({ tz: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId));
    const timezone = tenant?.tz ?? "America/Merida";
    const found = await gatherAvailability(tx, { now, tenant: { timezone } }, {
      serviceId: q.serviceId,
      staffId: q.staffId,
      from: startOfLocalDay(day, timezone),
      to: startOfLocalDay(addDays(day, days), timezone),
    });
    if (!found.ok) return { ok: false as const, error: found.error };
    const names = new Map(found.staffRows.map((s) => [s.id, s.name]));
    return {
      ok: true as const,
      timezone,
      service: { id: found.service.id, name: found.service.name, durationMin: found.service.durationMin },
      slots: found.slots
        .map((s): ManualSlot => ({ startIso: s.start.toISOString(), staffId: s.staffId, staffName: names.get(s.staffId) ?? "" }))
        .sort((a, b) => a.startIso.localeCompare(b.startIso) || a.staffName.localeCompare(b.staffName)),
    };
  });
}

/**
 * Una persona agenda una cita para un cliente (panel): sin el protocolo de confirmacion del asistente, pero con
 * las mismas reglas de disponibilidad y la misma proteccion contra horarios empalmados. Queda en la bitacora.
 */
export async function bookAppointmentManually(
  db: Parameters<typeof withTenant>[0],
  input: { tenantId: string; userId: string; contactId: string; serviceId: string; staffId: string; startIso: string; sourceConversationId?: string | null; now?: Date },
): Promise<
  | { ok: true; appointmentId: string; startsAt: Date; endsAt: Date; service: { name: string; durationMin: number; priceCents: number | null; currency: string; requiresDeposit: boolean }; staffName: string }
  | { ok: false; error: ManualBookingError }
> {
  const start = new Date(input.startIso);
  if (Number.isNaN(start.getTime())) return { ok: false, error: "fecha_invalida" };
  const now = input.now ?? new Date();

  try {
    return await withTenant(db, { tenantId: input.tenantId, userId: input.userId }, async (tx) => {
      const [contact] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, input.contactId));
      if (!contact) return { ok: false as const, error: "contacto_no_encontrado" as const };
      const [tenant] = await tx.select({ tz: tenants.timezone }).from(tenants).where(eq(tenants.id, input.tenantId));
      const clock = { now, tenant: { timezone: tenant?.tz ?? "America/Merida" } };

      const check = await slotIsFree(tx, clock, { serviceId: input.serviceId, staffId: input.staffId, start });
      if (!check.ok) return { ok: false as const, error: check.error as ManualBookingError };
      if (!check.free) return { ok: false as const, error: "horario_no_disponible" as const };

      const service = check.service;
      const [row] = await tx
        .insert(appointments)
        .values({
          tenantId: input.tenantId,
          contactId: input.contactId,
          serviceId: service.id,
          staffId: input.staffId,
          startsAt: start,
          endsAt: new Date(start.getTime() + service.durationMin * 60_000),
          status: "confirmed",
          sourceConversationId: input.sourceConversationId ?? null,
        })
        .returning();
      await tx.insert(auditLog).values({
        tenantId: input.tenantId,
        userId: input.userId,
        action: "appointment.created",
        entity: "appointment",
        entityId: row!.id,
        diff: { actor: "panel", start: start.toISOString(), service: service.name },
      });
      return {
        ok: true as const,
        appointmentId: row!.id,
        startsAt: row!.startsAt,
        endsAt: row!.endsAt,
        service: { name: service.name, durationMin: service.durationMin, priceCents: service.priceCents, currency: service.currency, requiresDeposit: service.requiresDeposit },
        staffName: check.staffRows.find((s) => s.id === input.staffId)?.name ?? "",
      };
    });
  } catch (e) {
    if (pgCode(e) === "23P01") return { ok: false, error: "horario_no_disponible" }; // alguien lo tomo justo antes
    throw e;
  }
}

// -------------------------------------------------------- apoyo de las citas

async function upcomingAppointments(ctx: TurnContext) {
  return withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => {
    const rows = await tx
      .select({
        id: appointments.id,
        startsAt: appointments.startsAt,
        status: appointments.status,
        service: services.name,
        staff: staff.name,
      })
      .from(appointments)
      .innerJoin(services, eq(services.id, appointments.serviceId))
      .innerJoin(staff, eq(staff.id, appointments.staffId))
      .where(
        and(
          eq(appointments.contactId, ctx.contactId),
          inArray(appointments.status, [...ACTIVE_STATUSES]),
          gte(appointments.startsAt, ctx.now),
        ),
      )
      .orderBy(asc(appointments.startsAt));
    return rows;
  });
}
export { upcomingAppointments };

/** Solo citas del PROPIO cliente: nadie puede mover o cancelar la cita de otra persona. */
async function ownAppointment(ctx: TurnContext, appointmentId: string) {
  return withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => {
    const [row] = await tx
      .select({
        id: appointments.id,
        startsAt: appointments.startsAt,
        serviceId: appointments.serviceId,
        staffId: appointments.staffId,
        serviceName: services.name,
        durationMin: services.durationMin,
        staffName: staff.name,
      })
      .from(appointments)
      .innerJoin(services, eq(services.id, appointments.serviceId))
      .innerJoin(staff, eq(staff.id, appointments.staffId))
      .where(
        and(
          eq(appointments.id, appointmentId),
          eq(appointments.contactId, ctx.contactId),
          inArray(appointments.status, [...ACTIVE_STATUSES]),
          gte(appointments.startsAt, ctx.now),
        ),
      );
    return row ?? null;
  });
}

/** Politica de cambios: con poco aviso no lo resuelve el bot, lo ve una persona. */
function policyBlock(ctx: TurnContext, startsAt: Date): ToolResult | null {
  const notice = ctx.tenant.profile?.cancellationNoticeHours ?? 12;
  const hours = (startsAt.getTime() - ctx.now.getTime()) / 3_600_000;
  if (hours >= notice) return null;
  return {
    error: "fuera_de_politica",
    politica: ctx.tenant.profile?.cancellationPolicy ?? `Se requieren ${notice} horas de aviso.`,
    instruccion: `Faltan menos de ${notice} horas para la cita. No la cambies ni la canceles tú: explica la política con amabilidad y usa escalar_a_humano para que una persona lo decida.`,
  };
}

// ------------------------------------------------------------------ registro

export function toolDefinitions(): ToolDefinition[] {
  return (Object.keys(TOOLS) as ToolName[]).map((name) => {
    const { $schema: _omit, ...parameters } = z.toJSONSchema(schemas[name], { io: "input" }) as Record<string, unknown>;
    return {
      type: "function" as const,
      function: { name, description: TOOLS[name].description, parameters },
    };
  });
}

export function isMutating(name: string): boolean {
  return name in TOOLS && TOOLS[name as ToolName].mutating;
}

export interface ToolRun {
  name: string;
  args: unknown;
  result: ToolResult;
}

/** Valida los argumentos que mando el modelo, ejecuta y nunca deja escapar una excepcion cruda. */
export async function runTool(name: string, rawArgs: string, ctx: TurnContext): Promise<ToolRun> {
  if (!(name in TOOLS)) {
    return { name, args: rawArgs, result: { error: "herramienta_desconocida", disponibles: Object.keys(TOOLS) } };
  }
  const toolName = name as ToolName;

  let parsed: unknown;
  try {
    parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return { name, args: rawArgs, result: { error: "argumentos_invalidos", detalle: "No es JSON válido" } };
  }
  const validation = schemas[toolName].safeParse(parsed);
  if (!validation.success) {
    return {
      name,
      args: parsed,
      result: {
        error: "argumentos_invalidos",
        detalle: validation.error.issues.map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`),
      },
    };
  }
  try {
    // El cast es seguro: validation.data viene del esquema de ESTA herramienta.
    const spec = TOOLS[toolName] as ToolSpec<ToolName>;
    const result = await spec.execute(validation.data as never, ctx);
    return { name, args: validation.data, result };
  } catch (error) {
    console.error(`[agent] error en la herramienta ${name}:`, error);
    return {
      name,
      args: validation.data,
      result: {
        error: "error_interno",
        instruccion: "Hubo un problema técnico. No inventes un resultado: disculpa y usa escalar_a_humano.",
      },
    };
  }
}

/**
 * Ejecuta acciones propuestas que una persona YA aprobo. Se saltan la confirmacion del
 * cliente (ya la dio la persona) y escriben de verdad.
 */
export async function applyApprovedActions(
  ctx: TurnContext,
  actions: ProposedAction[],
): Promise<ToolRun[]> {
  const live: TurnContext = { ...ctx, mode: "live", skipConfirmation: true, proposedActions: [], attachments: [] };
  const runs: ToolRun[] = [];
  for (const action of actions) {
    if (!isMutating(action.tool)) {
      runs.push({ name: action.tool, args: action.args, result: { error: "accion_no_permitida" } });
      continue;
    }
    runs.push(await runTool(action.tool, JSON.stringify(action.args), live));
  }
  return runs;
}
