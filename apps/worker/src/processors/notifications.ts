import { humanAvailability } from "@empleado/agent";
import { STAFF_ALERT_TEMPLATE, staffAlertParamList } from "@empleado/channels";
import {
  auditLog,
  channels,
  contacts,
  conversations,
  handoffs,
  handoffsToNotify,
  notificationSettings,
  templates,
  tenants,
  withTenant,
  type Database,
} from "@empleado/db";
import { sendEmail, tenantAccess, type EmailDeps } from "@empleado/inbox";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { loadChannelAccess } from "../channel-access";
import type { Logger } from "../config";
import type { Sender } from "./outbound";

/**
 * Avisa al EQUIPO cuando una conversacion necesita a una persona (la pidio el cliente, o hay urgencia o queja).
 * Cada minuto el worker revisa las escalaciones pendientes de aviso. El aviso va por WhatsApp (plantilla aprobada, desde
 * el numero del negocio al del equipo) y/o por correo, segun lo que el negocio configuro.
 */

export interface NotifyDeps {
  db: Database;
  key: Buffer;
  makeSender(access: { accessToken: string; phoneNumberId: string; channelType: string }): Sender;
  /** Correo: null = sin servicio configurado (los destinatarios de correo se omiten). */
  email: EmailDeps | null;
  sendEmail?: typeof sendEmail;
  /** Direccion publica del panel, para el enlace a la conversacion. */
  baseUrl: string | null;
  now?: () => Date;
  log?: Logger;
}

export type NotifyResult =
  | { status: "sent"; whatsapp: number; email: number }
  | { status: "skipped"; reason: "not_found" | "already" | "no_access" | "closed" | "nothing_ready" }
  | { status: "failed" };

const CHANNEL_LABEL: Record<string, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram", voice: "llamada" };
const KIND_LABEL: Record<string, string> = {
  pidio_persona: "pidió hablar con una persona",
  urgencia: "urgencia",
  queja: "queja",
};

const nick = (profile: unknown): string | null => {
  const p = (profile ?? {}) as Record<string, unknown>;
  const v = [p.whatsapp_name, p.messenger_name, p.instagram_name].find((x) => typeof x === "string" && x);
  return typeof v === "string" ? v : null;
};

export function createNotifier(deps: NotifyDeps) {
  const log = deps.log ?? (() => {});
  const send = deps.sendEmail ?? sendEmail;

  return async (job: { tenantId: string; handoffId: string }): Promise<NotifyResult> => {
    const { tenantId, handoffId } = job;
    const now = deps.now?.() ?? new Date();

    const loaded = await withTenant(deps.db, { tenantId }, async (tx) => {
      const [row] = await tx
        .select({ h: handoffs, conv: conversations, contact: contacts, channelType: channels.type, tenant: tenants })
        .from(handoffs)
        .innerJoin(conversations, eq(conversations.id, handoffs.conversationId))
        .innerJoin(contacts, eq(contacts.id, conversations.contactId))
        .innerJoin(channels, eq(channels.id, conversations.channelId))
        .innerJoin(tenants, eq(tenants.id, handoffs.tenantId))
        .where(eq(handoffs.id, handoffId));
      if (!row) return null;
      const [settings] = await tx.select().from(notificationSettings);
      const [wa] = await tx.select().from(channels).where(and(eq(channels.type, "whatsapp"), eq(channels.status, "active"))).orderBy(asc(channels.createdAt)).limit(1);
      const [template] = wa
        ? await tx
            .select({ id: templates.id })
            .from(templates)
            .where(and(eq(templates.channelId, wa.id), eq(templates.name, STAFF_ALERT_TEMPLATE.name), eq(templates.language, STAFF_ALERT_TEMPLATE.language), eq(templates.status, "approved")))
        : [];
      return { ...row, settings, waChannel: wa, hasTemplate: Boolean(template) };
    });

    if (!loaded || !loaded.settings?.enabled) return { status: "skipped", reason: "not_found" };
    const { h, contact, channelType, tenant, settings } = loaded;
    if (h.notifiedAt || h.resolvedAt) return { status: "skipped", reason: "already" };
    if (!(await tenantAccess(deps.db, tenantId)).allowed) return { status: "skipped", reason: "no_access" };

    // "Solo en horario": se queda pendiente y sale cuando abre el horario de atencion humana.
    if (settings.mode !== "always" && !humanAvailability(tenant.humanHours, now, tenant.timezone).openNow) return { status: "skipped", reason: "closed" };

    const recipients = settings.recipients.filter((r) => r.enabled);
    const customer = contact.displayName ?? nick(contact.profile) ?? contact.phoneE164 ?? "Un cliente";
    const channelLabel = CHANNEL_LABEL[channelType] ?? channelType;
    const kindLabel = KIND_LABEL[h.kind] ?? (h.urgency === "alta" ? "urgencia" : "necesita atención");
    const detail = (h.summary ?? h.reason ?? "").trim();
    const reason = detail ? `${kindLabel}. ${detail}` : kindLabel;
    const url = `${(deps.baseUrl ?? "https://app.tamia.com.mx").replace(/\/$/, "")}/bandeja?c=${h.conversationId}`;

    // Se "reclama" ANTES de enviar: con mas de un worker no se duplica el aviso. Si todo falla, se libera.
    const claimed = await withTenant(deps.db, { tenantId }, (tx) =>
      tx.update(handoffs).set({ notifiedAt: now }).where(and(eq(handoffs.id, handoffId), isNull(handoffs.notifiedAt))).returning({ id: handoffs.id }),
    );
    if (claimed.length === 0) return { status: "skipped", reason: "already" };

    let whatsapp = 0;
    let email = 0;
    let hardFailures = 0;
    let notReady = 0;

    for (const r of recipients) {
      try {
        if (r.kind === "whatsapp") {
          if (!loaded.waChannel || !loaded.hasTemplate) {
            notReady++;
            continue;
          }
          const access = await loadChannelAccess(deps.db, deps.key, tenantId, loaded.waChannel.id);
          if (!access?.accessToken) {
            notReady++;
            continue;
          }
          await deps.makeSender({ accessToken: access.accessToken, phoneNumberId: access.phoneNumberId, channelType: access.type }).sendTemplate(r.address.replace(/\D/g, ""), {
            name: STAFF_ALERT_TEMPLATE.name,
            language: STAFF_ALERT_TEMPLATE.language,
            bodyParams: staffAlertParamList({ business: tenant.name, customer, channel: channelLabel, reason, url }),
          });
          whatsapp++;
        } else {
          if (!deps.email) {
            notReady++;
            continue;
          }
          await send(deps.email, {
            to: r.address,
            subject: `${customer} necesita a una persona · ${tenant.name}`,
            text: `${customer} escribió por ${channelLabel} a ${tenant.name} y necesita que una persona lo atienda.\n\nMotivo: ${reason}\n\nAbre la conversación: ${url}\n\n— Tamia`,
          });
          email++;
        }
      } catch (error) {
        hardFailures++;
        log("notify.recipient_failed", { tenantId, handoffId, kind: r.kind, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (whatsapp + email === 0) {
      // Nada salio: se libera para reintentar. Solo cuenta como intento si hubo un fallo real (no "aun no hay plantilla").
      await withTenant(deps.db, { tenantId }, (tx) =>
        tx
          .update(handoffs)
          .set({ notifiedAt: null, notifyAttempts: sql`${handoffs.notifyAttempts} + ${hardFailures > 0 ? 1 : 0}` })
          .where(eq(handoffs.id, handoffId)),
      );
      if (notReady > 0) log("notify.not_ready", { tenantId, handoffId, hint: "Falta la plantilla de aviso aprobada, el canal de WhatsApp o el servicio de correo" });
      return hardFailures > 0 ? { status: "failed" } : { status: "skipped", reason: "nothing_ready" };
    }

    await withTenant(deps.db, { tenantId }, (tx) =>
      tx.insert(auditLog).values({ tenantId, action: "notification.sent", entity: "handoff", entityId: handoffId, diff: { kind: h.kind, whatsapp, email } as never }),
    );
    log("notify.sent", { tenantId, handoffId, whatsapp, email });
    return { status: "sent", whatsapp, email };
  };
}

/** Revisa que escalaciones toca avisar. Lo llama el worker cada minuto. */
export function createNotificationScanner(deps: NotifyDeps) {
  const notify = createNotifier(deps);
  const warned = new Map<string, number>();
  return async (): Promise<{ sent: number; skipped: number; errors: number }> => {
    const due = await handoffsToNotify(deps.db, 50);
    let sent = 0;
    let skipped = 0;
    let errors = 0;
    for (const job of due) {
      try {
        const r = await notify(job);
        if (r.status === "sent") sent++;
        else if (r.status === "failed") errors++;
        else skipped++;
      } catch (error) {
        errors++;
        const key = `${job.tenantId}:error`;
        if ((deps.now?.() ?? new Date()).getTime() - (warned.get(key) ?? 0) > 600_000) {
          warned.set(key, (deps.now?.() ?? new Date()).getTime());
          deps.log?.("notify.error", { ...job, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    return { sent, skipped, errors };
  };
}
