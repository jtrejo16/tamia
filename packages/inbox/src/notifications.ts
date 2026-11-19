import { STAFF_ALERT_TEMPLATE, REVIEW_REQUEST_TEMPLATE } from "@empleado/channels";
import { auditLog, channels, notificationSettings, reviewSettings, templates, withTenant, type Database, type NotificationRecipient } from "@empleado/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { can, fail, type Failure, type PanelContext, type Success } from "./types";

/**
 * Ajustes de dos funciones del negocio (solo el dueño las cambia):
 *  - Avisos: cuando una conversacion necesita a una persona se avisa al equipo (WhatsApp o correo).
 *  - Resenas: despues de la cita se le pide al cliente su resena por WhatsApp.
 */

// ----------------------------------------------------------------- telefonos

/** Numero mexicano o internacional a E.164. "999 123 4567" -> +529991234567; "+52 1 999 123 4567" -> +529991234567. */
export function normalizePhone(input: string): string | null {
  const raw = input.trim();
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) {
    const d = digits.startsWith("521") && digits.length === 13 ? `52${digits.slice(3)}` : digits;
    return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  }
  if (digits.length === 10) return `+52${digits}`;
  if (digits.length === 12 && digits.startsWith("52")) return `+${digits}`;
  if (digits.length === 13 && digits.startsWith("521")) return `+52${digits.slice(3)}`;
  return null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ----------------------------------------------------------------- avisos al equipo

export type SettingsError = "forbidden" | "invalid";
export type Fail = Failure<SettingsError> & { details?: string[] };

export interface NotificationSettingsView {
  enabled: boolean;
  mode: "business_hours" | "always";
  recipients: NotificationRecipient[];
  /** El negocio tiene un WhatsApp conectado desde el cual mandar el aviso. */
  hasWhatsApp: boolean;
  /** Estado de la plantilla de aviso en Meta (null = aun no se crea). */
  template: { status: string } | null;
}

const MAX_RECIPIENTS = 3;

const notificationInput = z.object({
  enabled: z.boolean(),
  mode: z.enum(["business_hours", "always"]),
  recipients: z
    .array(
      z.object({
        id: z.string().max(60).optional(),
        kind: z.enum(["whatsapp", "email"]),
        address: z.string().trim().min(3).max(120),
        enabled: z.boolean().default(true),
      }),
    )
    .max(MAX_RECIPIENTS, `Máximo ${MAX_RECIPIENTS} destinatarios`),
});

async function templateStatus(tx: Parameters<Parameters<typeof withTenant>[2]>[0], name: string): Promise<{ status: string } | null> {
  const [t] = await tx.select({ status: templates.status }).from(templates).where(eq(templates.name, name)).limit(1);
  return t ?? null;
}

export async function getNotificationSettings(db: Database, ctx: PanelContext): Promise<NotificationSettingsView> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [s] = await tx.select().from(notificationSettings);
    const [wa] = await tx.select({ id: channels.id }).from(channels).where(and(eq(channels.type, "whatsapp"), eq(channels.status, "active"))).limit(1);
    return {
      enabled: s?.enabled ?? false,
      mode: (s?.mode === "always" ? "always" : "business_hours") as "business_hours" | "always",
      recipients: s?.recipients ?? [],
      hasWhatsApp: Boolean(wa),
      template: await templateStatus(tx, STAFF_ALERT_TEMPLATE.name),
    };
  });
}

export async function saveNotificationSettings(db: Database, ctx: PanelContext, raw: unknown): Promise<Success<{ needsTemplate: boolean }> | Fail> {
  if (!can(ctx.role, "configure")) return { ok: false, error: "forbidden" };
  const parsed = notificationInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid", details: parsed.error.issues.map((i) => i.message) };

  const recipients: NotificationRecipient[] = [];
  const seen = new Set<string>();
  for (const r of parsed.data.recipients) {
    const address = r.kind === "email" ? r.address.toLowerCase() : normalizePhone(r.address);
    if (!address || (r.kind === "email" && (!EMAIL.test(address) || address.length > 120))) {
      return { ok: false, error: "invalid", details: [r.kind === "email" ? `Correo no válido: ${r.address}` : `Número no válido: ${r.address}`] };
    }
    if (seen.has(`${r.kind}:${address}`)) return { ok: false, error: "invalid", details: [`Repetido: ${r.address}`] };
    seen.add(`${r.kind}:${address}`);
    recipients.push({ id: r.id && /^[A-Za-z0-9-]{6,60}$/.test(r.id) ? r.id : randomUUID(), kind: r.kind, address, enabled: r.enabled });
  }
  if (parsed.data.enabled && !recipients.some((r) => r.enabled)) {
    return { ok: false, error: "invalid", details: ["Agrega al menos un destinatario activo para encender los avisos"] };
  }

  await withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const values = { enabled: parsed.data.enabled, mode: parsed.data.mode, recipients, updatedAt: new Date() };
    const [existing] = await tx.select({ id: notificationSettings.id }).from(notificationSettings);
    if (existing) await tx.update(notificationSettings).set(values).where(eq(notificationSettings.id, existing.id));
    else await tx.insert(notificationSettings).values({ tenantId: ctx.tenantId, ...values });
    // Sin direcciones en la bitacora: solo cuantos y de que tipo.
    await tx.insert(auditLog).values({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "settings.notifications",
      entity: "notification_settings",
      entityId: ctx.tenantId,
      diff: { enabled: values.enabled, mode: values.mode, whatsapp: recipients.filter((r) => r.kind === "whatsapp").length, email: recipients.filter((r) => r.kind === "email").length } as never,
    });
  });
  return { ok: true, needsTemplate: parsed.data.enabled && recipients.some((r) => r.enabled && r.kind === "whatsapp") };
}

// ----------------------------------------------------------------- resenas

export interface ReviewSettingsView {
  enabled: boolean;
  hoursAfter: number;
  platform: "google" | "facebook" | "other";
  url: string;
  hasWhatsApp: boolean;
  template: { status: string } | null;
}

const PLATFORM_HOSTS: Record<string, RegExp | null> = {
  google: /(^|\.)(google\.[a-z.]+|g\.page|goo\.gl|maps\.app\.goo\.gl|g\.co)$/i,
  facebook: /(^|\.)(facebook\.com|fb\.com|fb\.me)$/i,
  other: null,
};

const reviewInput = z.object({
  enabled: z.boolean(),
  hoursAfter: z.number().int().min(1, "Mínimo 1 hora").max(48, "Máximo 48 horas"),
  platform: z.enum(["google", "facebook", "other"]),
  url: z.string().trim().max(300).default(""),
});

export async function getReviewSettings(db: Database, ctx: PanelContext): Promise<ReviewSettingsView> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [s] = await tx.select().from(reviewSettings);
    const [wa] = await tx.select({ id: channels.id }).from(channels).where(and(eq(channels.type, "whatsapp"), eq(channels.status, "active"))).limit(1);
    return {
      enabled: s?.enabled ?? false,
      hoursAfter: s?.hoursAfter ?? 3,
      platform: (s?.platform === "facebook" || s?.platform === "other" ? s.platform : "google") as "google" | "facebook" | "other",
      url: s?.url ?? "",
      hasWhatsApp: Boolean(wa),
      template: await templateStatus(tx, REVIEW_REQUEST_TEMPLATE.name),
    };
  });
}

export async function saveReviewSettings(db: Database, ctx: PanelContext, raw: unknown, now = new Date()): Promise<Success<{ needsTemplate: boolean }> | Fail> {
  if (!can(ctx.role, "configure")) return { ok: false, error: "forbidden" };
  const parsed = reviewInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid", details: parsed.error.issues.map((i) => i.message) };
  const { enabled, hoursAfter, platform } = parsed.data;

  let url = parsed.data.url;
  if (url) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { ok: false, error: "invalid", details: ["El enlace no es válido. Pégalo completo, empezando con https://"] };
    }
    if (u.protocol !== "https:") return { ok: false, error: "invalid", details: ["El enlace debe empezar con https://"] };
    const hosts = PLATFORM_HOSTS[platform];
    if (hosts && !hosts.test(u.hostname)) {
      return { ok: false, error: "invalid", details: [platform === "google" ? "Ese enlace no parece de Google. Usa el enlace para pedir reseñas de tu Perfil de Negocio de Google." : "Ese enlace no parece de Facebook."] };
    }
    url = u.toString();
  }
  if (enabled && !url) return { ok: false, error: "invalid", details: ["Pega el enlace donde quieres que dejen la reseña para encender esta función"] };

  await withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [existing] = await tx.select().from(reviewSettings);
    // Al ENCENDERLA solo se pide resena de citas que terminen desde ese momento (no de las ya pasadas).
    const enabledAt = enabled ? (existing?.enabled && existing.enabledAt ? existing.enabledAt : now) : (existing?.enabledAt ?? null);
    const values = { enabled, hoursAfter, platform, url: url || null, enabledAt, updatedAt: new Date() };
    if (existing) await tx.update(reviewSettings).set(values).where(eq(reviewSettings.id, existing.id));
    else await tx.insert(reviewSettings).values({ tenantId: ctx.tenantId, ...values });
    await tx.insert(auditLog).values({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "settings.reviews",
      entity: "review_settings",
      entityId: ctx.tenantId,
      diff: { enabled, hoursAfter, platform } as never,
    });
  });
  return { ok: true, needsTemplate: enabled };
}
