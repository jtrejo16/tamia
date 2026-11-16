import { ensureConversation, formatWhen } from "@empleado/agent";
import {
  REMINDER_TEMPLATES,
  buttonPayloads,
  encodeTemplateMessage,
  reminderParamList,
  type InboundMessage,
  type OutboundJobData,
  type ReminderAction,
  type ReminderKind,
} from "@empleado/channels";
import {
  appointments,
  auditLog,
  channels,
  contacts,
  conversations,
  dueReminders,
  messages,
  services,
  templates,
  tenants,
  withTenant,
  type Database,
} from "@empleado/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Logger } from "../config";

const ACTIVE = ["pending", "confirmed"] as const;

const firstName = (name: string | null | undefined): string => (name?.trim().split(/\s+/)[0] ?? "") || "cliente";
const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

export interface ReminderDeps {
  db: Database;
  enqueueOutbound(job: OutboundJobData): Promise<void>;
  now?: () => Date;
  log?: Logger;
}

export type ReminderSkip =
  | "not_found"
  | "inactive"
  | "not_due"
  | "no_channel"
  | "no_template"
  | "no_phone"
  | "opted_out"
  | "already_sent";

export type ReminderResult = { status: "sent"; messageId: string } | { status: "skipped"; reason: ReminderSkip };

const MIN_MS: Record<ReminderKind, [number, number]> = {
  // [minimo antes de la cita, maximo antes de la cita] en milisegundos
  "24h": [3 * 3600_000, 24 * 3600_000],
  "2h": [20 * 60_000, 2 * 3600_000],
};

/** Envia (encola) UN recordatorio. Idempotente: el UPDATE condicional impide duplicados. */
export function createReminderProcessor(deps: ReminderDeps) {
  const log = deps.log ?? (() => {});

  return async (job: { tenantId: string; appointmentId: string; kind: ReminderKind }): Promise<ReminderResult> => {
    const { tenantId, appointmentId, kind } = job;
    const now = deps.now?.() ?? new Date();
    const def = REMINDER_TEMPLATES[kind];

    const loaded = await withTenant(deps.db, { tenantId }, async (tx) => {
      const [row] = await tx
        .select({ a: appointments, contact: contacts, service: services, tenant: tenants })
        .from(appointments)
        .innerJoin(contacts, eq(contacts.id, appointments.contactId))
        .innerJoin(services, eq(services.id, appointments.serviceId))
        .innerJoin(tenants, eq(tenants.id, appointments.tenantId))
        .where(eq(appointments.id, appointmentId));
      if (!row) return null;
      const [channel] = await tx
        .select()
        .from(channels)
        .where(and(eq(channels.type, "whatsapp"), eq(channels.status, "active")))
        .orderBy(asc(channels.createdAt))
        .limit(1);
      const [template] = channel
        ? await tx
            .select()
            .from(templates)
            .where(
              and(
                eq(templates.channelId, channel.id),
                eq(templates.name, def.name),
                eq(templates.language, def.language),
                eq(templates.status, "approved"),
              ),
            )
        : [];
      return { ...row, channel, template };
    });

    if (!loaded) return { status: "skipped", reason: "not_found" };
    const { a, contact, service, tenant, channel, template } = loaded;
    if (!(ACTIVE as readonly string[]).includes(a.status)) return { status: "skipped", reason: "inactive" };
    const already = kind === "24h" ? a.reminder24hSentAt : a.reminder2hSentAt;
    if (already) return { status: "skipped", reason: "already_sent" };

    const untilStart = a.startsAt.getTime() - now.getTime();
    const [min, max] = MIN_MS[kind];
    if (untilStart <= min || untilStart > max) return { status: "skipped", reason: "not_due" };
    if (!contact.phoneE164 || !/^\+\d{8,15}$/.test(contact.phoneE164)) return { status: "skipped", reason: "no_phone" };
    if (contact.optedOutAt) return { status: "skipped", reason: "opted_out" };
    if (!channel) return { status: "skipped", reason: "no_channel" };
    // Sin plantilla aprobada NO se marca como enviado: saldra apenas Meta la apruebe.
    if (!template) return { status: "skipped", reason: "no_template" };

    const ref = await ensureConversation(deps.db, { tenantId, channelId: channel.id, phone: contact.phoneE164 });
    const params = reminderParamList({
      customerName: firstName(contact.displayName ?? ((contact.profile as Record<string, unknown>)?.whatsapp_name as string | undefined)),
      service: lowerFirst(service.name),
      when: formatWhen(a.startsAt, tenant.timezone),
      business: tenant.name,
    });

    const messageId = await withTenant(deps.db, { tenantId }, async (tx) => {
      const claimed = await tx
        .update(appointments)
        .set(kind === "24h" ? { reminder24hSentAt: now } : { reminder2hSentAt: now })
        .where(
          and(
            eq(appointments.id, appointmentId),
            kind === "24h" ? isNull(appointments.reminder24hSentAt) : isNull(appointments.reminder2hSentAt),
            inArray(appointments.status, [...ACTIVE]),
          ),
        )
        .returning({ id: appointments.id });
      if (claimed.length === 0) return null;

      const [msg] = await tx
        .insert(messages)
        .values({
          tenantId,
          conversationId: ref.conversationId,
          channelId: channel.id,
          direction: "out",
          sender: "bot",
          type: "template",
          body: encodeTemplateMessage(def, params, buttonPayloads(appointmentId)),
          status: "queued",
        })
        .returning({ id: messages.id });
      // OJO: lastInboundAt NO se toca: un recordatorio no abre la ventana de 24 h.
      await tx.update(conversations).set({ lastMessageAt: now, updatedAt: now }).where(eq(conversations.id, ref.conversationId));
      return msg!.id;
    });
    if (!messageId) return { status: "skipped", reason: "already_sent" };

    await deps.enqueueOutbound({ tenantId, messageId }).catch(() => {}); // si falla, el barrido lo recupera
    log("reminder.queued", { tenantId, appointmentId, kind, messageId });
    return { status: "sent", messageId };
  };
}

/** Revisa que recordatorios tocan ahora y los envia. Lo llama el worker cada minuto. */
export function createReminderScanner(deps: ReminderDeps) {
  const process = createReminderProcessor(deps);
  const warned = new Map<string, number>(); // para no repetir el mismo aviso cada minuto

  return async (options: { tenantId?: string } = {}): Promise<{ sent: number; skipped: number; errors: number }> => {
    const now = deps.now?.() ?? new Date();
    const due = (await dueReminders(deps.db, now, options.tenantId ? 1000 : 100)).filter(
      (j) => !options.tenantId || j.tenantId === options.tenantId,
    );
    let sent = 0;
    let skipped = 0;
    let errors = 0;

    for (const job of due) {
      try {
        const result = await process(job);
        if (result.status === "sent") sent++;
        else {
          skipped++;
          if (result.reason === "no_template" || result.reason === "no_channel") {
            const key = `${job.tenantId}:${result.reason}`;
            if (now.getTime() - (warned.get(key) ?? 0) > 3600_000) {
              warned.set(key, now.getTime());
              deps.log?.("reminder.cannot_send", { tenantId: job.tenantId, reason: result.reason, hint: "Crea y aprueba las plantillas de recordatorio" });
            }
          }
        }
      } catch (error) {
        errors++;
        deps.log?.("reminder.error", { ...job, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { sent, skipped, errors };
  };
}

// ----------------------------------------------------------------- botones

export type ReminderReplyOutcome =
  | { handled: true; queued: string[] }
  /** No se resolvio aqui: el agente debe atender el mensaje (con este texto). */
  | { handled: false; text: string };

/**
 * Respuesta a los botones de un recordatorio.
 *  - "Confirmo": se marca la cita como confirmada por el cliente y se le agradece (sin IA).
 *  - "Reagendar": se pasa al agente con el contexto de la cita, para que ofrezca horarios.
 * Solo se actua sobre citas DEL PROPIO cliente: un identificador ajeno no sirve.
 */
export async function handleReminderReply(
  deps: ReminderDeps,
  input: {
    tenantId: string;
    ref: { conversationId: string; contactId: string; channelId: string };
    message: InboundMessage;
    reply: ReminderAction;
  },
): Promise<ReminderReplyOutcome> {
  const { tenantId, ref, message, reply } = input;
  const now = deps.now?.() ?? new Date();

  const loaded = await withTenant(deps.db, { tenantId }, async (tx) => {
    const [row] = await tx
      .select({ a: appointments, service: services, tenant: tenants, conv: conversations, contact: contacts })
      .from(appointments)
      .innerJoin(services, eq(services.id, appointments.serviceId))
      .innerJoin(tenants, eq(tenants.id, appointments.tenantId))
      .innerJoin(conversations, eq(conversations.id, ref.conversationId))
      .innerJoin(contacts, eq(contacts.id, appointments.contactId))
      .where(
        and(
          eq(appointments.id, reply.appointmentId),
          eq(appointments.contactId, ref.contactId),
          inArray(appointments.status, [...ACTIVE]),
        ),
      );
    return row ?? null;
  });

  // Cita inexistente, ajena o ya cancelada: lo atiende el agente como un mensaje normal.
  if (!loaded) return { handled: false, text: message.text || (reply.action === "confirm" ? "Confirmo mi cita" : "Quiero reagendar mi cita") };

  const when = formatWhen(loaded.a.startsAt, loaded.tenant.timezone);
  const what = lowerFirst(loaded.service.name);

  if (reply.action === "resched") {
    return { handled: false, text: `[Botón "Reagendar" del recordatorio] Quiero reagendar mi cita de ${what} del ${when}.` };
  }

  const queued = await withTenant(deps.db, { tenantId }, async (tx) => {
    const saved = await tx
      .insert(messages)
      .values({
        tenantId,
        conversationId: ref.conversationId,
        channelId: ref.channelId,
        direction: "in",
        sender: "contact",
        type: "interactive",
        body: message.text || "Confirmo",
        externalId: message.id,
        status: "received",
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    if (saved.length === 0) return [] as string[]; // el mismo mensaje ya se proceso

    await tx
      .update(conversations)
      .set({ lastInboundAt: now, lastMessageAt: now, updatedAt: now, ...(loaded.conv.state === "closed" ? { state: "bot" as const } : {}) })
      .where(eq(conversations.id, ref.conversationId));
    await tx
      .update(appointments)
      .set({ confirmedByContact: true, status: "confirmed", updatedAt: now })
      .where(eq(appointments.id, reply.appointmentId));
    await tx.insert(auditLog).values({
      tenantId,
      action: "appointment.confirmed_by_contact",
      entity: "appointment",
      entityId: reply.appointmentId,
      diff: { via: "boton_de_recordatorio" },
    });

    // Si una persona tiene el control de la conversacion, ella decide si contesta.
    if (loaded.conv.state === "human") return [] as string[];
    const [ack] = await tx
      .insert(messages)
      .values({
        tenantId,
        conversationId: ref.conversationId,
        channelId: ref.channelId,
        direction: "out",
        sender: "bot",
        type: "text",
        body: `¡Gracias, ${firstName(loaded.contact.displayName)}! Tu cita de ${what} queda confirmada para el ${when}. Te esperamos en ${loaded.tenant.name}.`,
        status: "queued",
      })
      .returning({ id: messages.id });
    return [ack!.id];
  });

  for (const messageId of queued) await deps.enqueueOutbound({ tenantId, messageId }).catch(() => {});
  return { handled: true, queued };
}
