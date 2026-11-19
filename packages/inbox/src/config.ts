import {
  agentConfigs,
  auditLog,
  businessHolidays,
  businessHours,
  knowledgeDocs,
  services,
  staff,
  staffServices,
  tenants,
  withTenant,
  type Database,
  type TenantProfile,
  type Tx,
} from "@empleado/db";
import { MODEL_TIERS, assertApprovedModel, type ModelTier } from "@empleado/llm";
import { and, asc, eq, gte, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { listTemplates, type TemplateView } from "./templates";
import { can, fail, type Failure, type PanelContext, type Success } from "./types";

// ----------------------------------------------------------------- validacion

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => z.preprocess(emptyToUndefined, text(max).optional());
const httpsUrl = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .max(300)
    .url()
    .refine((u) => u.startsWith("https://"), "Debe empezar con https://")
    .optional(),
);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Usa el formato HH:MM (por ejemplo 09:00)");
const list = (max: number, item = 200) => z.array(text(item).min(1)).max(max);

const validTimezone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("es-MX", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export const businessSchema = z.object({
  name: text(120).min(2, "Escribe el nombre del negocio"),
  description: optText(300),
  address: optText(200),
  mapsUrl: httpsUrl,
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  paymentMethods: list(12, 60),
  keyFacts: list(12),
  cancellationPolicy: optText(300),
  cancellationNoticeHours: z.number().int().min(0).max(168),
  humanResumeHours: z.number().int().min(0).max(168).optional(),
  depositPolicy: optText(300),
  privacyNoticeUrl: httpsUrl,
  timezone: z.string().refine(validTimezone, "Zona horaria no válida (por ejemplo America/Merida)"),
  // Parcial: un dia sin entrada (o null) significa "no hay atencion humana ese dia".
  humanHours: z.partialRecord(z.enum(DAY_KEYS), z.tuple([hhmm, hhmm]).nullable()),
});
export type BusinessInput = z.input<typeof businessSchema>;

export const TIERS = ["economico", "balanceado", "premium"] as const satisfies readonly ModelTier[];
export const agentSchema = z.object({
  assistantName: text(40).min(2, "Ponle un nombre al asistente"),
  tone: text(80).min(2),
  formality: z.enum(["tu", "usted"]),
  autonomy: z.enum(["copilot", "semi", "auto"]),
  tier: z.enum(TIERS),
  escalationRules: list(20, 120),
  forbiddenTopics: list(20, 120),
});
export type AgentInput = z.input<typeof agentSchema>;

export const serviceSchema = z.object({
  id: z.uuid().optional(),
  name: text(80).min(2, "Escribe el nombre del servicio"),
  description: optText(200),
  durationMin: z.number().int().min(5).max(480),
  bufferMin: z.number().int().min(0).max(120),
  /** En pesos (la base de datos guarda centavos). Nulo = "a valorar". */
  price: z.number().min(0).max(1_000_000).nullable(),
  requiresDeposit: z.boolean(),
  active: z.boolean(),
  staffIds: z.array(z.uuid()).max(50),
});
export type ServiceInput = z.input<typeof serviceSchema>;

export const staffSchema = z.object({
  id: z.uuid().optional(),
  name: text(80).min(2, "Escribe el nombre"),
  roleLabel: optText(60),
  active: z.boolean(),
  serviceIds: z.array(z.uuid()).max(100),
});
export type StaffInput = z.input<typeof staffSchema>;

export const hoursSchema = z
  .object({
    /** Nulo = horario general del negocio. */
    staffId: z.uuid().nullable(),
    windows: z
      .array(z.object({ weekday: z.number().int().min(0).max(6), opens: hhmm, closes: hhmm }))
      .max(28),
  })
  .superRefine((v, ctx) => {
    v.windows.forEach((w, i) => {
      if (w.closes <= w.opens) ctx.addIssue({ code: "custom", message: "La hora de cierre debe ser después de la de apertura", path: ["windows", i] });
    });
    const sorted = [...v.windows].sort((a, b) => a.weekday - b.weekday || a.opens.localeCompare(b.opens));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (prev.weekday === cur.weekday && cur.opens < prev.closes) {
        ctx.addIssue({ code: "custom", message: "Hay horarios encimados en el mismo día", path: ["windows"] });
      }
    }
  });
export type HoursInput = z.input<typeof hoursSchema>;

export const holidaySchema = z.object({
  staffId: z.uuid().nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa AAAA-MM-DD").refine((d) => !Number.isNaN(Date.parse(d)), "Fecha no válida"),
  reason: optText(80),
});
export type HolidayInput = z.input<typeof holidaySchema>;

export const docSchema = z.object({
  id: z.uuid().optional(),
  title: text(100).min(2, "Ponle un título"),
  text: z.string().trim().min(1, "Escribe el contenido").max(20_000),
});
export type DocInput = z.input<typeof docSchema>;

type Invalid = Failure<"invalid"> & { details: string[] };
function parse<S extends z.ZodType>(schema: S, input: unknown): { ok: true; data: z.output<S> } | Invalid {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  return {
    ok: false,
    error: "invalid",
    details: r.error.issues.map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`),
  };
}

// ------------------------------------------------------------------ lectura

export interface ConfigSnapshot {
  business: {
    name: string;
    description: string;
    address: string;
    mapsUrl: string;
    latitude: number | null;
    longitude: number | null;
    paymentMethods: string[];
    keyFacts: string[];
    cancellationPolicy: string;
    cancellationNoticeHours: number;
    humanResumeHours: number;
    depositPolicy: string;
    privacyNoticeUrl: string;
    timezone: string;
    humanHours: Record<string, [string, string] | null>;
    vertical: string;
  };
  agent: {
    assistantName: string;
    tone: string;
    formality: "tu" | "usted";
    autonomy: "copilot" | "semi" | "auto";
    tier: ModelTier | "personalizado";
    model: string;
    escalationRules: string[];
    forbiddenTopics: string[];
  } | null;
  services: Array<{
    id: string;
    name: string;
    description: string;
    durationMin: number;
    bufferMin: number;
    price: number | null;
    requiresDeposit: boolean;
    active: boolean;
    staffIds: string[];
  }>;
  staff: Array<{ id: string; name: string; roleLabel: string; active: boolean; serviceIds: string[]; ownHours: boolean }>;
  hours: Array<{ id: string; staffId: string | null; weekday: number; opens: string; closes: string }>;
  holidays: Array<{ id: string; staffId: string | null; date: string; reason: string }>;
  docs: Array<{ id: string; title: string; text: string; updatedAt: Date }>;
  templates: TemplateView[];
}

const hm = (t: string) => t.slice(0, 5);

export async function getConfig(db: Database, ctx: PanelContext, now: Date = new Date()): Promise<ConfigSnapshot | null> {
  const scope = { tenantId: ctx.tenantId, userId: ctx.userId };
  const data = await withTenant(db, scope, async (tx) => {
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
    if (!tenant) return null;
    const [agent] = await tx.select().from(agentConfigs).where(eq(agentConfigs.tenantId, ctx.tenantId));
    const since = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
    return {
      tenant,
      agent,
      svc: await tx.select().from(services).orderBy(asc(services.name)),
      links: await tx.select().from(staffServices),
      members: await tx.select().from(staff).orderBy(asc(staff.name)),
      hours: await tx.select().from(businessHours).orderBy(asc(businessHours.weekday), asc(businessHours.opens)),
      holidays: await tx.select().from(businessHolidays).where(gte(businessHolidays.date, since)).orderBy(asc(businessHolidays.date)),
      docs: await tx.select().from(knowledgeDocs).orderBy(asc(knowledgeDocs.title)),
    };
  });
  if (!data) return null;
  const { tenant, agent } = data;
  const p: TenantProfile = tenant.profile ?? {};
  const tier = agent
    ? ((Object.entries(MODEL_TIERS).find(([, t]) => t.model === agent.model)?.[0] as ModelTier | undefined) ?? "personalizado")
    : "personalizado";

  return {
    business: {
      name: tenant.name,
      description: p.description ?? "",
      address: p.address ?? "",
      mapsUrl: p.mapsUrl ?? "",
      latitude: p.latitude ?? null,
      longitude: p.longitude ?? null,
      paymentMethods: p.paymentMethods ?? [],
      keyFacts: p.keyFacts ?? [],
      cancellationPolicy: p.cancellationPolicy ?? "",
      cancellationNoticeHours: p.cancellationNoticeHours ?? 12,
      humanResumeHours: p.humanResumeHours ?? 4,
      depositPolicy: p.depositPolicy ?? "",
      privacyNoticeUrl: tenant.privacyNoticeUrl ?? "",
      timezone: tenant.timezone,
      humanHours: (tenant.humanHours ?? {}) as Record<string, [string, string] | null>,
      vertical: tenant.vertical,
    },
    agent: agent
      ? {
          assistantName: agent.assistantName,
          tone: agent.tone,
          formality: agent.formality === "tu" ? "tu" : "usted",
          autonomy: agent.autonomy,
          tier,
          model: agent.model,
          escalationRules: agent.escalationRules,
          forbiddenTopics: agent.forbiddenTopics,
        }
      : null,
    services: data.svc.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description ?? "",
      durationMin: s.durationMin,
      bufferMin: s.bufferMin,
      price: s.priceCents == null ? null : s.priceCents / 100,
      requiresDeposit: s.requiresDeposit,
      active: s.active,
      staffIds: data.links.filter((l) => l.serviceId === s.id).map((l) => l.staffId),
    })),
    staff: data.members.map((m) => ({
      id: m.id,
      name: m.name,
      roleLabel: m.roleLabel ?? "",
      active: m.active,
      serviceIds: data.links.filter((l) => l.staffId === m.id).map((l) => l.serviceId),
      ownHours: data.hours.some((h) => h.staffId === m.id),
    })),
    hours: data.hours.map((h) => ({ id: h.id, staffId: h.staffId, weekday: h.weekday, opens: hm(h.opens), closes: hm(h.closes) })),
    holidays: data.holidays.map((h) => ({ id: h.id, staffId: h.staffId, date: h.date, reason: h.reason ?? "" })),
    docs: data.docs.map((d) => ({ id: d.id, title: d.title, text: d.rawText ?? "", updatedAt: d.updatedAt })),
    templates: await listTemplates(db, ctx),
  };
}

// --------------------------------------------------------------- escritura

type ConfigError = "forbidden" | "invalid" | "not_found";
type Out<T = object> = Success<T> | Failure<"forbidden" | "not_found"> | Invalid;

const record = (tx: Tx, ctx: PanelContext, action: string, entityId: string | null, diff?: unknown) =>
  tx.insert(auditLog).values({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    action: `config.${action}`,
    entity: "config",
    entityId,
    diff: (diff ?? null) as never,
  });

const scopeOf = (ctx: PanelContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });
const guard = (ctx: PanelContext) => (can(ctx.role, "configure") ? null : fail("forbidden" as const));

export async function updateBusiness(db: Database, ctx: PanelContext, input: unknown): Promise<Out> {
  const denied = guard(ctx);
  if (denied) return denied;
  const v = parse(businessSchema, input);
  if (!v.ok) return v;
  const d = v.data;

  const profile: TenantProfile = {
    ...(d.description ? { description: d.description } : {}),
    ...(d.address ? { address: d.address } : {}),
    ...(d.mapsUrl ? { mapsUrl: d.mapsUrl } : {}),
    ...(d.latitude !== undefined && d.longitude !== undefined ? { latitude: d.latitude, longitude: d.longitude } : {}),
    paymentMethods: d.paymentMethods,
    keyFacts: d.keyFacts,
    ...(d.cancellationPolicy ? { cancellationPolicy: d.cancellationPolicy } : {}),
    cancellationNoticeHours: d.cancellationNoticeHours,
    humanResumeHours: d.humanResumeHours ?? 4,
    ...(d.depositPolicy ? { depositPolicy: d.depositPolicy } : {}),
  };
  return withTenant(db, scopeOf(ctx), async (tx) => {
    await tx
      .update(tenants)
      .set({
        name: d.name,
        profile,
        privacyNoticeUrl: d.privacyNoticeUrl ?? null,
        timezone: d.timezone,
        humanHours: d.humanHours,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, ctx.tenantId));
    await record(tx, ctx, "business.updated", ctx.tenantId, { name: d.name, timezone: d.timezone });
    return { ok: true as const };
  });
}

export async function updateAgent(db: Database, ctx: PanelContext, input: unknown): Promise<Out> {
  const denied = guard(ctx);
  if (denied) return denied;
  const v = parse(agentSchema, input);
  if (!v.ok) return v;
  const d = v.data;
  const tier = MODEL_TIERS[d.tier];
  assertApprovedModel(tier.model);
  assertApprovedModel(tier.fallback);

  return withTenant(db, scopeOf(ctx), async (tx) => {
    const [current] = await tx.select().from(agentConfigs).where(eq(agentConfigs.tenantId, ctx.tenantId));
    const values = {
      assistantName: d.assistantName,
      tone: d.tone,
      formality: d.formality,
      autonomy: d.autonomy,
      model: tier.model,
      fallbackModel: tier.fallback,
      escalationRules: d.escalationRules,
      forbiddenTopics: d.forbiddenTopics,
      updatedAt: new Date(),
    };
    if (current) await tx.update(agentConfigs).set(values).where(eq(agentConfigs.tenantId, ctx.tenantId));
    else await tx.insert(agentConfigs).values({ tenantId: ctx.tenantId, ...values });
    await record(tx, ctx, "agent.updated", ctx.tenantId, {
      autonomy: { from: current?.autonomy ?? null, to: d.autonomy },
      tier: d.tier,
    });
    return { ok: true as const };
  });
}

export async function saveService(db: Database, ctx: PanelContext, input: unknown): Promise<Out<{ id: string }>> {
  const denied = guard(ctx);
  if (denied) return denied;
  const v = parse(serviceSchema, input);
  if (!v.ok) return v;
  const d = v.data;

  return withTenant(db, scopeOf(ctx), async (tx) => {
    const values = {
      name: d.name,
      description: d.description ?? null,
      durationMin: d.durationMin,
      bufferMin: d.bufferMin,
      priceCents: d.price === null ? null : Math.round(d.price * 100),
      requiresDeposit: d.requiresDeposit,
      active: d.active,
      updatedAt: new Date(),
    };
    let id = d.id;
    if (id) {
      const updated = await tx.update(services).set(values).where(eq(services.id, id)).returning({ id: services.id });
      if (updated.length === 0) return fail("not_found" as const);
    } else {
      const [row] = await tx.insert(services).values({ tenantId: ctx.tenantId, ...values }).returning({ id: services.id });
      id = row!.id;
    }
    // Solo se pueden asignar especialistas de ESTE negocio.
    const valid = d.staffIds.length ? await tx.select({ id: staff.id }).from(staff).where(inArray(staff.id, d.staffIds)) : [];
    await tx.delete(staffServices).where(eq(staffServices.serviceId, id));
    if (valid.length) await tx.insert(staffServices).values(valid.map((s) => ({ tenantId: ctx.tenantId, staffId: s.id, serviceId: id! })));
    await record(tx, ctx, d.id ? "service.updated" : "service.created", id, { name: d.name });
    return { ok: true as const, id };
  });
}

/** Un servicio con citas no se borra: se desactiva (deja de ofrecerse, el historial se conserva). */
export async function setServiceActive(db: Database, ctx: PanelContext, id: string, active: boolean): Promise<Out> {
  const denied = guard(ctx);
  if (denied) return denied;
  return withTenant(db, scopeOf(ctx), async (tx) => {
    const r = await tx.update(services).set({ active, updatedAt: new Date() }).where(eq(services.id, id)).returning({ id: services.id });
    if (r.length === 0) return fail("not_found" as const);
    await record(tx, ctx, active ? "service.activated" : "service.deactivated", id);
    return { ok: true as const };
  });
}

export async function saveStaff(db: Database, ctx: PanelContext, input: unknown): Promise<Out<{ id: string }>> {
  const denied = guard(ctx);
  if (denied) return denied;
  const v = parse(staffSchema, input);
  if (!v.ok) return v;
  const d = v.data;

  return withTenant(db, scopeOf(ctx), async (tx) => {
    const values = { name: d.name, roleLabel: d.roleLabel ?? null, active: d.active, updatedAt: new Date() };
    let id = d.id;
    if (id) {
      const updated = await tx.update(staff).set(values).where(eq(staff.id, id)).returning({ id: staff.id });
      if (updated.length === 0) return fail("not_found" as const);
    } else {
      const [row] = await tx.insert(staff).values({ tenantId: ctx.tenantId, ...values }).returning({ id: staff.id });
      id = row!.id;
    }
    const valid = d.serviceIds.length ? await tx.select({ id: services.id }).from(services).where(inArray(services.id, d.serviceIds)) : [];
    await tx.delete(staffServices).where(eq(staffServices.staffId, id));
    if (valid.length) await tx.insert(staffServices).values(valid.map((s) => ({ tenantId: ctx.tenantId, staffId: id!, serviceId: s.id })));
    await record(tx, ctx, d.id ? "staff.updated" : "staff.created", id, { name: d.name });
    return { ok: true as const, id };
  });
}

/**
 * Reemplaza el horario de un alcance: el del negocio (staffId nulo) o el propio de un
 * especialista. Sin ventanas = el especialista vuelve a seguir el horario del negocio.
 */
export async function setHours(db: Database, ctx: PanelContext, input: unknown): Promise<Out> {
  const denied = guard(ctx);
  if (denied) return denied;
  const v = parse(hoursSchema, input);
  if (!v.ok) return v;
  const { staffId, windows } = v.data;

  return withTenant(db, scopeOf(ctx), async (tx) => {
    if (staffId) {
      const [member] = await tx.select({ id: staff.id }).from(staff).where(eq(staff.id, staffId));
      if (!member) return fail("not_found" as const);
    }
    await tx.delete(businessHours).where(staffId ? eq(businessHours.staffId, staffId) : isNull(businessHours.staffId));
    if (windows.length) {
      await tx.insert(businessHours).values(
        windows.map((w) => ({ tenantId: ctx.tenantId, staffId, weekday: w.weekday, opens: w.opens, closes: w.closes })),
      );
    }
    await record(tx, ctx, "hours.updated", staffId, { scope: staffId ? "staff" : "business", windows: windows.length });
    return { ok: true as const };
  });
}

export async function addHoliday(db: Database, ctx: PanelContext, input: unknown): Promise<Out<{ id: string }>> {
  const denied = guard(ctx);
  if (denied) return denied;
  const v = parse(holidaySchema, input);
  if (!v.ok) return v;
  const d = v.data;
  return withTenant(db, scopeOf(ctx), async (tx) => {
    if (d.staffId) {
      const [member] = await tx.select({ id: staff.id }).from(staff).where(eq(staff.id, d.staffId));
      if (!member) return fail("not_found" as const);
    }
    const [row] = await tx
      .insert(businessHolidays)
      .values({ tenantId: ctx.tenantId, staffId: d.staffId, date: d.date, reason: d.reason ?? null })
      .returning({ id: businessHolidays.id });
    await record(tx, ctx, "holiday.added", row!.id, { date: d.date });
    return { ok: true as const, id: row!.id };
  });
}

export async function removeHoliday(db: Database, ctx: PanelContext, id: string): Promise<Out> {
  const denied = guard(ctx);
  if (denied) return denied;
  return withTenant(db, scopeOf(ctx), async (tx) => {
    const r = await tx.delete(businessHolidays).where(eq(businessHolidays.id, id)).returning({ id: businessHolidays.id });
    if (r.length === 0) return fail("not_found" as const);
    await record(tx, ctx, "holiday.removed", id);
    return { ok: true as const };
  });
}

/** Documentos de conocimiento (preguntas frecuentes, politicas...): lo que el asistente consulta. */
export async function saveDoc(db: Database, ctx: PanelContext, input: unknown): Promise<Out<{ id: string }>> {
  const denied = guard(ctx);
  if (denied) return denied;
  const v = parse(docSchema, input);
  if (!v.ok) return v;
  const d = v.data;
  return withTenant(db, scopeOf(ctx), async (tx) => {
    let id = d.id;
    if (id) {
      const r = await tx
        .update(knowledgeDocs)
        .set({ title: d.title, rawText: d.text, status: "ready", updatedAt: new Date() })
        .where(eq(knowledgeDocs.id, id))
        .returning({ id: knowledgeDocs.id });
      if (r.length === 0) return fail("not_found" as const);
    } else {
      const [row] = await tx
        .insert(knowledgeDocs)
        .values({ tenantId: ctx.tenantId, title: d.title, sourceType: "text", rawText: d.text, status: "ready" })
        .returning({ id: knowledgeDocs.id });
      id = row!.id;
    }
    await record(tx, ctx, d.id ? "doc.updated" : "doc.created", id, { title: d.title });
    return { ok: true as const, id };
  });
}

export async function removeDoc(db: Database, ctx: PanelContext, id: string): Promise<Out> {
  const denied = guard(ctx);
  if (denied) return denied;
  return withTenant(db, scopeOf(ctx), async (tx) => {
    const r = await tx.delete(knowledgeDocs).where(and(eq(knowledgeDocs.id, id))).returning({ id: knowledgeDocs.id });
    if (r.length === 0) return fail("not_found" as const);
    await record(tx, ctx, "doc.removed", id);
    return { ok: true as const };
  });
}

export type { ConfigError };
