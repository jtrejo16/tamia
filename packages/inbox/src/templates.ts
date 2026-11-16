import {
  GraphAdminClient,
  REMINDER_TEMPLATES,
  WhatsAppApiError,
  type RemoteTemplate,
  type TemplateDefinition,
} from "@empleado/channels";
import { channels, templates, withTenant, type Database } from "@empleado/db";
import { and, asc, eq } from "drizzle-orm";
import { loadChannelAccess } from "./channel-access";
import { can, fail, type Failure, type PanelContext, type Success } from "./types";

export interface TemplateGraphDeps {
  /** Llave AES-256 para abrir el token del canal. */
  key: Buffer;
  apiVersion?: string;
  /** Para desarrollo/pruebas: Graph API alterno. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface TemplateView {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  /** Texto de la plantilla, si la creamos nosotros. */
  bodyText: string | null;
  isReminder: boolean;
  updatedAt: Date;
}

const REMINDER_NAMES = new Set(Object.values(REMINDER_TEMPLATES).map((t) => t.name));

export async function listTemplates(db: Database, ctx: PanelContext): Promise<TemplateView[]> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const rows = await tx.select().from(templates).orderBy(asc(templates.name));
    return rows.map((t): TemplateView => {
      const components = Array.isArray(t.components) ? (t.components as Array<{ type?: string; text?: string }>) : [];
      return {
        id: t.id,
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        bodyText: components.find((c) => c.type?.toUpperCase() === "BODY")?.text ?? null,
        isReminder: REMINDER_NAMES.has(t.name),
        updatedAt: t.updatedAt,
      };
    });
  });
}

export type TemplateError =
  | "forbidden"
  | "no_channel"
  | "no_token"
  | "no_waba"
  | "meta_rejected"
  | "meta_unavailable";

type Prepared =
  | { ok: true; admin: GraphAdminClient; channelId: string; wabaId: string }
  | Failure<TemplateError>;

async function prepare(
  db: Database,
  deps: TemplateGraphDeps,
  tenantId: string,
  channelId?: string,
): Promise<Prepared> {
  const [channel] = await withTenant(db, { tenantId }, (tx) =>
    tx
      .select()
      .from(channels)
      .where(channelId ? eq(channels.id, channelId) : and(eq(channels.type, "whatsapp"), eq(channels.status, "active")))
      .limit(1),
  );
  if (!channel || channel.type !== "whatsapp") return fail("no_channel");
  const access = await loadChannelAccess(db, deps.key, tenantId, channel.id);
  if (!access?.accessToken) return fail("no_token");
  if (!access.wabaId) return fail("no_waba");
  return {
    ok: true,
    channelId: channel.id,
    wabaId: access.wabaId,
    admin: new GraphAdminClient({
      accessToken: access.accessToken,
      apiVersion: deps.apiVersion,
      baseUrl: deps.baseUrl,
      fetch: deps.fetch,
    }),
  };
}

const lowerCategory = (c: string): "utility" | "marketing" | "authentication" =>
  c.toUpperCase() === "MARKETING" ? "marketing" : c.toUpperCase() === "AUTHENTICATION" ? "authentication" : "utility";

async function store(db: Database, tenantId: string, channelId: string, remote: RemoteTemplate[]): Promise<number> {
  return withTenant(db, { tenantId }, async (tx) => {
    let changed = 0;
    for (const r of remote) {
      const [existing] = await tx
        .select()
        .from(templates)
        .where(and(eq(templates.channelId, channelId), eq(templates.name, r.name), eq(templates.language, r.language)));
      if (existing) {
        if (existing.status !== r.status || existing.metaTemplateId !== r.id) {
          await tx
            .update(templates)
            .set({ status: r.status, metaTemplateId: r.id, updatedAt: new Date() })
            .where(eq(templates.id, existing.id));
          changed++;
        }
      } else {
        await tx.insert(templates).values({
          tenantId,
          channelId,
          name: r.name,
          language: r.language,
          category: lowerCategory(r.category),
          components: {},
          status: r.status,
          metaTemplateId: r.id,
        });
        changed++;
      }
    }
    return changed;
  });
}

function metaFailure(error: unknown): Failure<TemplateError> & { details: string } {
  if (error instanceof WhatsAppApiError) {
    return { ok: false, error: error.retryable ? "meta_unavailable" : "meta_rejected", details: error.message };
  }
  throw error;
}

/** Trae de Meta el estado de las plantillas y lo guarda. Lo usa el worker y el boton "Sincronizar". */
export async function syncTemplates(
  db: Database,
  deps: TemplateGraphDeps,
  tenantId: string,
  channelId?: string,
): Promise<Success<{ synced: number; total: number }> | (Failure<TemplateError> & { details?: string })> {
  const prepared = await prepare(db, deps, tenantId, channelId);
  if (!prepared.ok) return prepared;
  try {
    const remote = await prepared.admin.listTemplates(prepared.wabaId);
    const changed = await store(db, tenantId, prepared.channelId, remote);
    return { ok: true, synced: changed, total: remote.length };
  } catch (error) {
    return metaFailure(error);
  }
}

/**
 * Crea en Meta las plantillas de recordatorio que falten (24 h y 2 h). Es idempotente: si ya
 * existen (en cualquier estado) no las vuelve a crear. Meta las revisa despues.
 */
export async function createReminderTemplates(
  db: Database,
  deps: TemplateGraphDeps,
  ctx: PanelContext,
): Promise<Success<{ created: string[]; existing: string[] }> | (Failure<TemplateError> & { details?: string })> {
  if (!can(ctx.role, "configure")) return fail("forbidden");
  const prepared = await prepare(db, deps, ctx.tenantId);
  if (!prepared.ok) return prepared;

  try {
    const remote = await prepared.admin.listTemplates(prepared.wabaId);
    await store(db, ctx.tenantId, prepared.channelId, remote);
    const have = new Set(remote.map((t) => `${t.name}|${t.language}`));

    const created: string[] = [];
    const existing: string[] = [];
    for (const def of Object.values(REMINDER_TEMPLATES) as TemplateDefinition[]) {
      if (have.has(`${def.name}|${def.language}`)) {
        existing.push(def.name);
        continue;
      }
      const result = await prepared.admin.createTemplate(prepared.wabaId, def);
      await withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
        tx
          .insert(templates)
          .values({
            tenantId: ctx.tenantId,
            channelId: prepared.channelId,
            name: def.name,
            language: def.language,
            category: "utility",
            components: [{ type: "BODY", text: def.body }, { type: "BUTTONS", buttons: def.quickReplies }],
            status: result.status,
            metaTemplateId: result.id,
          })
          .onConflictDoNothing(),
      );
      created.push(def.name);
    }
    // Guarda el texto de las que ya existian en Meta, para poder mostrarlas.
    await withTenant(db, { tenantId: ctx.tenantId }, async (tx) => {
      for (const def of Object.values(REMINDER_TEMPLATES) as TemplateDefinition[]) {
        await tx
          .update(templates)
          .set({ components: [{ type: "BODY", text: def.body }, { type: "BUTTONS", buttons: def.quickReplies }] })
          .where(and(eq(templates.channelId, prepared.channelId), eq(templates.name, def.name), eq(templates.language, def.language)));
      }
    });
    return { ok: true, created, existing };
  } catch (error) {
    return metaFailure(error);
  }
}
