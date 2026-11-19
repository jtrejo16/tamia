import { ensureConversation } from "@empleado/agent";
import {
  REVIEW_REQUEST_TEMPLATE,
  encodeTemplateMessage,
  reviewParamList,
  type OutboundJobData,
} from "@empleado/channels";
import {
  appointments,
  auditLog,
  channels,
  contacts,
  conversations,
  messages,
  reviewSettings,
  reviewsDue,
  templates,
  tenants,
  withTenant,
  type Database,
} from "@empleado/db";
import { tenantAccess } from "@empleado/inbox";
import { and, asc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import type { Logger } from "../config";

/**
 * Pide la resena al cliente unas horas despues de su cita, por WhatsApp (plantilla aprobada), sin importar por que medio
 * se agendo (Messenger, Instagram, llamada, WhatsApp o el panel): lo unico que hace falta es su telefono.
 * Reglas: una vez por cita; una vez cada 90 dias por cliente; nunca a quien pidio no recibir mensajes ni a citas
 * canceladas o de "no asistio"; y NO se filtra por satisfaccion ni se ofrece nada a cambio (lo prohibe Google).
 */

export const REVIEW_COOLDOWN_DAYS = 90;
const ACTIVE = ["confirmed", "done"] as const;

export interface ReviewDeps {
  db: Database;
  enqueueOutbound(job: OutboundJobData): Promise<void>;
  now?: () => Date;
  log?: Logger;
}

export type ReviewSkip =
  | "not_found"
  | "disabled"
  | "inactive"
  | "not_due"
  | "no_phone"
  | "opted_out"
  | "recent_request"
  | "no_channel"
  | "no_template"
  | "no_access"
  | "already";

export type ReviewResult = { status: "sent"; messageId: string } | { status: "skipped"; reason: ReviewSkip };

const firstName = (name: string | null | undefined): string => (name?.trim().split(/\s+/)[0] ?? "") || "cliente";

/** Motivos que NO se arreglan solos: la cita se da por atendida para que no estorbe en la fila de pendientes. */
const PERMANENT: ReadonlySet<ReviewSkip> = new Set(["no_phone", "opted_out", "recent_request", "inactive"]);

export function createReviewProcessor(deps: ReviewDeps) {
  const log = deps.log ?? (() => {});

  return async (job: { tenantId: string; appointmentId: string }): Promise<ReviewResult> => {
    const { tenantId, appointmentId } = job;
    const now = deps.now?.() ?? new Date();

    const loaded = await withTenant(deps.db, { tenantId }, async (tx) => {
      const [row] = await tx
        .select({ a: appointments, contact: contacts, tenant: tenants })
        .from(appointments)
        .innerJoin(contacts, eq(contacts.id, appointments.contactId))
        .innerJoin(tenants, eq(tenants.id, appointments.tenantId))
        .where(eq(appointments.id, appointmentId));
      if (!row) return null;
      const [settings] = await tx.select().from(reviewSettings);
      const [channel] = await tx.select().from(channels).where(and(eq(channels.type, "whatsapp"), eq(channels.status, "active"))).orderBy(asc(channels.createdAt)).limit(1);
      const [template] = channel
        ? await tx
            .select({ id: templates.id })
            .from(templates)
            .where(and(eq(templates.channelId, channel.id), eq(templates.name, REVIEW_REQUEST_TEMPLATE.name), eq(templates.language, REVIEW_REQUEST_TEMPLATE.language), eq(templates.status, "approved")))
        : [];
      // ¿Ya se le pidio resena a este cliente (por cualquier cita) hace poco?
      const since = new Date(now.getTime() - REVIEW_COOLDOWN_DAYS * 86_400_000);
      const [recent] = await tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(and(eq(appointments.contactId, row.contact.id), ne(appointments.id, appointmentId), gt(appointments.reviewRequestedAt, since)))
        .limit(1);
      return { ...row, settings, channel, hasTemplate: Boolean(template), recent: Boolean(recent) };
    });

    if (!loaded) return { status: "skipped", reason: "not_found" };
    const { a, contact, tenant, settings, channel } = loaded;
    if (a.reviewRequestedAt) return { status: "skipped", reason: "already" };
    if (!settings?.enabled || !settings.url) return { status: "skipped", reason: "disabled" };

    const decide = async (reason: ReviewSkip): Promise<ReviewResult> => {
      if (PERMANENT.has(reason)) {
        await withTenant(deps.db, { tenantId }, (tx) =>
          tx.update(appointments).set({ reviewRequestedAt: now }).where(and(eq(appointments.id, appointmentId), isNull(appointments.reviewRequestedAt))),
        );
      }
      return { status: "skipped", reason };
    };

    if (!(ACTIVE as readonly string[]).includes(a.status)) return decide("inactive");
    if (a.endsAt.getTime() + settings.hoursAfter * 3_600_000 > now.getTime()) return { status: "skipped", reason: "not_due" };
    if (!contact.phoneE164 || !/^\+\d{8,15}$/.test(contact.phoneE164)) return decide("no_phone");
    if (contact.optedOutAt) return decide("opted_out");
    if (loaded.recent) return decide("recent_request");
    if (!(await tenantAccess(deps.db, tenantId)).allowed) return { status: "skipped", reason: "no_access" };
    if (!channel) return { status: "skipped", reason: "no_channel" };
    // Sin plantilla aprobada NO se marca: saldra apenas Meta la apruebe (mientras la cita siga dentro de la ventana de 3 dias).
    if (!loaded.hasTemplate) return { status: "skipped", reason: "no_template" };

    const ref = await ensureConversation(deps.db, { tenantId, channelId: channel.id, phone: contact.phoneE164 });
    const params = reviewParamList({
      customer: firstName(contact.displayName ?? ((contact.profile as Record<string, unknown>)?.whatsapp_name as string | undefined)),
      business: tenant.name,
      url: settings.url,
    });

    const messageId = await withTenant(deps.db, { tenantId }, async (tx) => {
      // Reclamo atomico: con mas de un worker no se manda dos veces.
      const claimed = await tx
        .update(appointments)
        .set({ reviewRequestedAt: now })
        .where(and(eq(appointments.id, appointmentId), isNull(appointments.reviewRequestedAt), inArray(appointments.status, [...ACTIVE])))
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
          body: encodeTemplateMessage(REVIEW_REQUEST_TEMPLATE, params, []),
          status: "queued",
        })
        .returning({ id: messages.id });
      // Como los recordatorios: no abre la ventana de 24 h (lastInboundAt no se toca).
      await tx.update(conversations).set({ lastMessageAt: now, updatedAt: now }).where(eq(conversations.id, ref.conversationId));
      await tx.insert(auditLog).values({ tenantId, action: "review.requested", entity: "appointment", entityId: appointmentId, diff: { platform: settings.platform } as never });
      return msg!.id;
    });
    if (!messageId) return { status: "skipped", reason: "already" };

    await deps.enqueueOutbound({ tenantId, messageId }).catch(() => {}); // si falla, el barrido lo recupera
    log("review.queued", { tenantId, appointmentId, messageId });
    return { status: "sent", messageId };
  };
}

/** Revisa a quien toca pedirle resena. Lo llama el worker cada minuto. */
export function createReviewScanner(deps: ReviewDeps) {
  const process = createReviewProcessor(deps);
  const warned = new Map<string, number>();
  return async (): Promise<{ sent: number; skipped: number; errors: number }> => {
    const due = await reviewsDue(deps.db, deps.now?.() ?? new Date(), 50);
    let sent = 0;
    let skipped = 0;
    let errors = 0;
    for (const job of due) {
      try {
        const r = await process(job);
        if (r.status === "sent") sent++;
        else {
          skipped++;
          if (r.reason === "no_template" || r.reason === "no_channel") {
            const key = `${job.tenantId}:${r.reason}`;
            const now = (deps.now?.() ?? new Date()).getTime();
            if (now - (warned.get(key) ?? 0) > 3_600_000) {
              warned.set(key, now);
              deps.log?.("review.cannot_send", { tenantId: job.tenantId, reason: r.reason, hint: "Falta la plantilla de reseña aprobada o el WhatsApp conectado" });
            }
          }
        }
      } catch (error) {
        errors++;
        deps.log?.("review.error", { ...job, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { sent, skipped, errors };
  };
}
