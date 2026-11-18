import { GraphAdminClient, WhatsAppApiError, openChannelCredentials } from "@empleado/channels";
import {
  auditLog,
  channels,
  isOperator,
  operatorExtendTrialRow,
  operatorOverviewRows,
  tenants,
  withTenant,
  type Database,
  type OperatorOverviewRow,
} from "@empleado/db";
import { PLANS, accessEndsAt, accessFor, isPlanId, type AccessReason, type SubscriptionFacts, type SubscriptionStatus, type TenantStatus } from "@empleado/shared";
import { desc, eq, sql } from "drizzle-orm";
import { getBilling, type BillingView } from "./billing";
import { getCalendarConnection, type CalendarView } from "./google-calendar";
import { getChannel, type ChannelView } from "./channel";
import { listSocialChannels, type SocialChannelView } from "./social-connect";
import type { TemplateGraphDeps } from "./templates";
import { listTemplates, type TemplateView } from "./templates";
import { listMembers, type MemberView } from "./users";
import { getVoiceSettings, type VoiceSettingsView } from "./voice";
import type { OperatorError } from "./operator";
import { fail, type Failure, type PanelContext, type Success } from "./types";

/**
 * Consola del operador (dueño de la plataforma): ver a todos los clientes (cobro, salud, conexiones) y dar
 * soporte. El permiso lo decide SIEMPRE la base de datos (users.is_operator), nunca la pantalla.
 * El soporte actua "como el dueño del negocio" con el id del operador, y TODO queda en la bitacora del negocio.
 */

const DAY = 86_400_000;
const daysBetween = (to: Date, from: Date) => Math.ceil((to.getTime() - from.getTime()) / DAY);

// ----------------------------------------------------------------- cobro

export type BillingBucket =
  | "pending" // negocio por aprobar
  | "trial" // en prueba gratis
  | "trial_ending" // la prueba termina en 3 dias o menos
  | "paid" // pagando al corriente
  | "due_soon" // pagando; el proximo cobro / fin del periodo es en 7 dias o menos
  | "overdue" // sin pago vigente (prueba terminada, pago atrasado)
  | "canceled" // cancelo la suscripcion
  | "comped" // cortesia
  | "paused" // negocio pausado o cancelado por el operador
  | "none"; // sin suscripcion registrada

export interface BillingState {
  bucket: BillingBucket;
  /** Fecha relevante: fin de prueba, proximo cobro o fin del acceso pagado. */
  dueAt: Date | null;
  /** Dias hasta `dueAt` (negativo si ya paso). */
  daysLeft: number | null;
  /** El asistente puede responder hoy (misma regla que usa el worker). */
  allowed: boolean;
  reason: AccessReason;
  /** Ingreso mensual (MXN) que aporta: solo suscripciones que pagan. */
  mrrMxn: number;
}

export function billingState(row: Pick<OperatorOverviewRow, "status" | "plan" | "subStatus" | "trialEndsAt" | "currentPeriodEnd" | "cardAuthorized">, now = new Date()): BillingState {
  const tenantStatus = row.status as TenantStatus;
  const facts: SubscriptionFacts | null = row.subStatus
    ? { status: row.subStatus as SubscriptionStatus, trialEndsAt: row.trialEndsAt, currentPeriodEnd: row.currentPeriodEnd, cardAuthorized: row.cardAuthorized }
    : null;
  const access = accessFor(tenantStatus, facts, now);
  const base = { allowed: access.allowed, reason: access.reason, mrrMxn: 0 };
  const left = (d: Date | null) => (d ? daysBetween(d, now) : null);

  if (tenantStatus === "pending") return { ...base, bucket: "pending", dueAt: null, daysLeft: null };
  if (tenantStatus !== "active") return { ...base, bucket: "paused", dueAt: null, daysLeft: null };
  if (!facts) return { ...base, bucket: "none", dueAt: null, daysLeft: null };

  switch (facts.status) {
    case "comped":
      return { ...base, bucket: "comped", dueAt: null, daysLeft: null };
    case "trialing": {
      const dueAt = facts.trialEndsAt;
      const daysLeft = left(dueAt);
      if (!access.allowed) return { ...base, bucket: "overdue", dueAt, daysLeft };
      return { ...base, bucket: daysLeft !== null && daysLeft <= 3 ? "trial_ending" : "trial", dueAt, daysLeft };
    }
    case "active": {
      const dueAt = facts.currentPeriodEnd;
      const daysLeft = left(dueAt);
      const price = isPlanId(row.plan) ? PLANS[row.plan].priceMxn : 0;
      if (!access.allowed) return { ...base, bucket: "overdue", dueAt, daysLeft };
      return { ...base, bucket: daysLeft !== null && daysLeft <= 7 ? "due_soon" : "paid", dueAt, daysLeft, mrrMxn: price };
    }
    case "past_due": {
      const dueAt = facts.currentPeriodEnd;
      return { ...base, bucket: "overdue", dueAt, daysLeft: left(dueAt) };
    }
    case "canceled": {
      const dueAt = accessEndsAt(facts);
      return { ...base, bucket: "canceled", dueAt, daysLeft: left(dueAt) };
    }
  }
}

// ----------------------------------------------------------------- salud

export type Severity = "error" | "warn" | "info";
export interface Issue {
  level: Severity;
  code: string;
  text: string;
}
export type HealthLevel = "ok" | "warn" | "error" | "na";

const CHANNEL_LABEL: Record<string, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram" };

/**
 * Problemas que el operador debe atender para un negocio ACTIVO. Solo mira datos que ya tenemos (sin llamar a
 * Meta); la comprobacion en vivo de las conexiones es aparte (botón "Comprobar conexiones").
 */
export function healthOf(row: OperatorOverviewRow, now = new Date()): { level: HealthLevel; issues: Issue[] } {
  if (row.status !== "active") return { level: "na", issues: [] };
  const issues: Issue[] = [];
  const add = (level: Severity, code: string, text: string) => issues.push({ level, code, text });
  const ageDays = (now.getTime() - row.createdAt.getTime()) / DAY;

  const connected = row.channels.filter((c) => c.hasToken && c.status === "active");
  if (connected.length === 0) add(ageDays < 2 ? "warn" : "error", "no_channel", "No tiene ningún canal conectado: el asistente no puede recibir ni mandar mensajes.");
  for (const c of row.channels) {
    const label = CHANNEL_LABEL[c.type] ?? c.type;
    if (c.status === "error") add("error", `channel_error_${c.type}`, `${label}: el canal está en error.`);
    else if (!c.hasToken || c.status === "paused") add("warn", `channel_off_${c.type}`, `${label}: está desconectado.`);
    if (c.quality && c.quality.toUpperCase() === "RED") add("error", `quality_${c.type}`, `${label}: Meta marcó la calidad del número en rojo.`);
    else if (c.quality && c.quality.toUpperCase() === "YELLOW") add("warn", `quality_${c.type}`, `${label}: la calidad del número está en amarillo.`);
  }
  if (row.failed24h >= 10) add("error", "failed_messages", `${row.failed24h} mensajes fallaron en las últimas 24 h.`);
  else if (row.failed24h >= 3) add("warn", "failed_messages", `${row.failed24h} mensajes fallaron en las últimas 24 h.`);

  if (connected.length > 0) {
    if (row.inbound7d === 0 && ageDays > 7) add("warn", "silent", "No ha recibido mensajes en 7 días (¿el webhook sigue llegando?).");
    // Ultimo mensaje del cliente sin respuesta: nadie contesto en mas de 30 min.
    if (row.lastInboundAt && now.getTime() - row.lastInboundAt.getTime() < DAY && now.getTime() - row.lastInboundAt.getTime() > 30 * 60_000 && (!row.lastOutboundAt || row.lastOutboundAt < row.lastInboundAt)) {
      add("warn", "unanswered", "El último mensaje de un cliente lleva más de 30 min sin respuesta.");
    }
  }
  if (row.openHandoffs > 0) add("info", "handoffs", `${row.openHandoffs} escalación(es) esperando a una persona.`);
  if (row.pendingApprovals >= 3) add("warn", "approvals", `${row.pendingApprovals} borradores esperan aprobación.`);
  if (row.calendarStatus === "error") add("warn", "calendar", "Google Calendar necesita reconectarse.");
  if (row.voiceEnabled && !row.voiceSynced) add("warn", "voice", "El asistente telefónico está activo pero no se ha sincronizado con Retell.");
  if (row.templatesRejected > 0) add("warn", "templates", `${row.templatesRejected} plantilla(s) rechazada(s) por Meta.`);

  const level: HealthLevel = issues.some((i) => i.level === "error") ? "error" : issues.some((i) => i.level === "warn") ? "warn" : "ok";
  return { level, issues };
}

// ----------------------------------------------------------------- resumen de la plataforma

export interface OperatorClient extends OperatorOverviewRow {
  billing: BillingState;
  health: { level: HealthLevel; issues: Issue[] };
}

export interface PlatformSummary {
  total: number;
  pendingApproval: number;
  trial: number;
  trialEnding: number;
  paying: number;
  dueSoon: number;
  overdue: number;
  canceled: number;
  comped: number;
  paused: number;
  /** Ingreso mensual estimado (MXN) de las suscripciones que pagan. */
  mrrMxn: number;
  /** Lo que vence en los proximos 7 dias entre quienes pagan (MXN). */
  renewingNext7dMxn: number;
  healthError: number;
  healthWarn: number;
  healthOk: number;
  withoutChannel: number;
  openHandoffs: number;
}

export function summarize(clients: OperatorClient[]): PlatformSummary {
  const s: PlatformSummary = {
    total: clients.length, pendingApproval: 0, trial: 0, trialEnding: 0, paying: 0, dueSoon: 0, overdue: 0, canceled: 0, comped: 0, paused: 0,
    mrrMxn: 0, renewingNext7dMxn: 0, healthError: 0, healthWarn: 0, healthOk: 0, withoutChannel: 0, openHandoffs: 0,
  };
  for (const c of clients) {
    switch (c.billing.bucket) {
      case "pending": s.pendingApproval++; break;
      case "trial": s.trial++; break;
      case "trial_ending": s.trial++; s.trialEnding++; break;
      case "paid": s.paying++; break;
      case "due_soon": s.paying++; s.dueSoon++; s.renewingNext7dMxn += c.billing.mrrMxn; break;
      case "overdue": s.overdue++; break;
      case "canceled": s.canceled++; break;
      case "comped": s.comped++; break;
      case "paused": s.paused++; break;
    }
    s.mrrMxn += c.billing.mrrMxn;
    if (c.health.level === "error") s.healthError++;
    else if (c.health.level === "warn") s.healthWarn++;
    else if (c.health.level === "ok") s.healthOk++;
    if (c.status === "active" && !c.channels.some((ch) => ch.hasToken && ch.status === "active")) s.withoutChannel++;
    s.openHandoffs += c.openHandoffs;
  }
  return s;
}

export async function operatorOverview(
  db: Database,
  userId: string,
  now = new Date(),
): Promise<Success<{ clients: OperatorClient[]; summary: PlatformSummary }> | Failure<"forbidden">> {
  if (!(await isOperator(db, userId))) return fail("forbidden");
  const rows = await operatorOverviewRows(db, userId);
  const clients = rows.map((r): OperatorClient => ({ ...r, billing: billingState(r, now), health: healthOf(r, now) }));
  return { ok: true, clients, summary: summarize(clients) };
}

// ----------------------------------------------------------------- soporte: actuar "como" el negocio

/**
 * Contexto para dar soporte a un negocio: el id del OPERADOR con rol de dueño de ESE negocio. Solo si el usuario
 * es operador y el negocio existe. Las funciones normales (conectar canal, sincronizar voz...) lo aceptan igual.
 */
export async function operatorSupportContext(db: Database, userId: string, tenantId: string): Promise<PanelContext | null> {
  if (!(await isOperator(db, userId))) return null;
  const [t] = await withTenant(db, { tenantId, userId }, (tx) => tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)));
  return t ? { tenantId, userId, role: "owner" } : null;
}

/** Deja constancia en la bitacora del negocio de que el operador hizo algo de soporte. */
export async function logSupportAction(db: Database, ctx: PanelContext, action: string, diff: Record<string, unknown> = {}): Promise<void> {
  await withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
    tx.insert(auditLog).values({ tenantId: ctx.tenantId, userId: ctx.userId, action: `operator.support.${action}`, entity: "tenant", entityId: ctx.tenantId, diff: diff as never }),
  );
}

export async function operatorExtendTrial(db: Database, userId: string, tenantId: string, days: unknown): Promise<Success | Failure<OperatorError>> {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 90) return fail("invalid");
  if (!(await isOperator(db, userId))) return fail("forbidden");
  return (await operatorExtendTrialRow(db, userId, tenantId, n)) ? { ok: true } : fail("not_found");
}

// ----------------------------------------------------------------- comprobar WhatsApp en vivo

export interface WhatsAppCheck {
  connected: boolean;
  tokenValid: boolean;
  displayPhone: string | null;
  verifiedName: string | null;
  quality: string | null;
  problems: string[];
}

/** Pregunta a Meta, con la clave guardada, si el numero de WhatsApp sigue accesible. No cambia nada. */
export async function checkWhatsAppConnection(db: Database, deps: TemplateGraphDeps, ctx: PanelContext): Promise<WhatsAppCheck> {
  const out: WhatsAppCheck = { connected: false, tokenValid: false, displayPhone: null, verifiedName: null, quality: null, problems: [] };
  const [c] = await withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, (tx) => tx.select().from(channels).where(eq(channels.type, "whatsapp")).limit(1));
  if (!c || !c.credentialsEnc) {
    out.problems.push("No hay un número de WhatsApp conectado.");
    return out;
  }
  out.connected = true;
  let token: string;
  try {
    token = openChannelCredentials(c.credentialsEnc, deps.key, ctx.tenantId, c.id).accessToken;
  } catch {
    out.problems.push("No se pudo leer la clave guardada. Desconecta y vuelve a conectar.");
    return out;
  }
  try {
    const p = await new GraphAdminClient({ accessToken: token, apiVersion: deps.apiVersion, baseUrl: deps.baseUrl, fetch: deps.fetch }).getPhoneNumber(c.externalId);
    out.tokenValid = true;
    out.displayPhone = p.displayPhone;
    out.verifiedName = p.verifiedName;
    out.quality = p.qualityRating;
    if (p.qualityRating?.toUpperCase() === "RED") out.problems.push("Meta marcó la calidad del número en rojo.");
  } catch (e) {
    if (e instanceof WhatsAppApiError && e.kind !== "server") out.problems.push(`Meta rechazó la clave guardada o el número (${e.message}). Vuelve a conectar.`);
    else out.problems.push("No se pudo consultar a Meta en este momento.");
  }
  return out;
}

// ----------------------------------------------------------------- detalle de un cliente

export interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  by: string | null;
  at: Date;
  diff: unknown;
}

export interface FailedMessage {
  at: Date;
  channel: string;
  error: string | null;
}

export interface TenantDetail {
  client: OperatorClient;
  billing: BillingView;
  whatsapp: ChannelView;
  social: SocialChannelView[];
  voice: VoiceSettingsView;
  calendar: CalendarView;
  templates: TemplateView[];
  members: MemberView[];
  audit: AuditEntry[];
  failures: FailedMessage[];
}

export async function operatorTenantDetail(
  db: Database,
  userId: string,
  tenantId: string,
  opts: { paymentsEnabled: boolean; retellConfigured: boolean; now?: Date },
): Promise<Success<{ detail: TenantDetail }> | Failure<"forbidden" | "not_found">> {
  const overview = await operatorOverview(db, userId, opts.now);
  if (!overview.ok) return overview;
  const client = overview.clients.find((c) => c.id === tenantId);
  if (!client) return fail("not_found");
  const ctx: PanelContext = { tenantId, userId, role: "owner" };

  const [billing, whatsapp, social, voice, calendar, templates, members] = await Promise.all([
    getBilling(db, ctx, opts.paymentsEnabled),
    getChannel(db, ctx),
    listSocialChannels(db, ctx),
    getVoiceSettings(db, ctx, opts.retellConfigured),
    getCalendarConnection(db, ctx),
    listTemplates(db, ctx),
    listMembers(db, ctx),
  ]);

  const audit = await withTenant(db, { tenantId, userId }, (tx) => tx.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(25));
  const names = new Map(members.map((m) => [m.userId, m.name ?? m.email]));
  const failures = await listFailedMessages(db, ctx);

  return {
    ok: true,
    detail: {
      client,
      billing,
      whatsapp,
      social,
      voice,
      calendar,
      templates,
      members,
      audit: audit.map((a) => ({
        id: a.id,
        action: a.action,
        entity: a.entity,
        by: a.userId ? (a.action.startsWith("operator.") ? "Operador" : (names.get(a.userId) ?? "Operador / otra persona")) : null,
        at: a.createdAt,
        diff: a.diff,
      })),
      failures,
    },
  };
}

async function listFailedMessages(db: Database, ctx: PanelContext): Promise<FailedMessage[]> {
  const rows = await withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
    tx.execute<{ at: Date; type: string; error: string | null }>(
      sql`select m.created_at as at, c.type, m.error from messages m join channels c on c.id = m.channel_id
          where m.tenant_id = ${ctx.tenantId} and m.direction = 'out' and m.status = 'failed' order by m.created_at desc limit 10`,
    ),
  );
  return rows.map((r) => ({ at: new Date(r.at), channel: r.type, error: r.error }));
}
