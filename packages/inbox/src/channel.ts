import { GraphAdminClient, WhatsAppApiError, sealChannelCredentials } from "@empleado/channels";
import { auditLog, channels, withTenant, type Database } from "@empleado/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TemplateGraphDeps } from "./templates";
import { can, fail, type Failure, type PanelContext, type Success } from "./types";

/** El canal de WhatsApp del negocio tal como lo ve el panel. NUNCA incluye el token. */
export interface ChannelView {
  connected: boolean;
  phoneNumberId: string | null;
  wabaId: string | null;
  displayPhone: string | null;
  status: "active" | "paused" | "error" | null;
  /** true si ya hay una clave de acceso guardada (cifrada). */
  hasToken: boolean;
  qualityRating: string | null;
}

export type ChannelError = "forbidden" | "invalid" | "meta_rejected" | "meta_unavailable" | "already_connected" | "no_channel";

const scope = (ctx: PanelContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

export async function getChannel(db: Database, ctx: PanelContext): Promise<ChannelView> {
  const [c] = await withTenant(db, scope(ctx), (tx) => tx.select().from(channels).where(eq(channels.type, "whatsapp")).limit(1));
  if (!c) return { connected: false, phoneNumberId: null, wabaId: null, displayPhone: null, status: null, hasToken: false, qualityRating: null };
  return {
    connected: c.credentialsEnc !== null && c.status === "active",
    phoneNumberId: c.externalId,
    wabaId: c.wabaId,
    displayPhone: c.displayPhone,
    status: c.status,
    hasToken: c.credentialsEnc !== null,
    qualityRating: c.qualityRating,
  };
}

const digits = (label: string) => z.string().trim().regex(/^\d{5,25}$/, `${label}: solo números (los ves en Meta)`);
const connectSchema = z.object({
  phoneNumberId: digits("Identificador del número"),
  wabaId: digits("Identificador de la cuenta de WhatsApp Business"),
  // Los tokens de Meta son largos, sin espacios.
  accessToken: z.string().trim().min(20, "La clave de acceso parece incompleta").max(1000).regex(/^\S+$/, "La clave de acceso no debe llevar espacios"),
});

/** Traduce un error de Meta a algo que se pueda explicar. */
function metaFailure(error: unknown): Failure<"meta_rejected" | "meta_unavailable"> | null {
  if (!(error instanceof WhatsAppApiError)) return null;
  return error.kind === "server" ? fail("meta_unavailable") : fail("meta_rejected");
}

/**
 * Conecta (o reemplaza) el numero de WhatsApp del negocio, solo dueño. Antes de guardar nada se
 * comprueba CON META que la clave de acceso realmente tiene acceso a ese numero y a esa cuenta, y se
 * suscribe nuestra app a la cuenta para que sus mensajes lleguen al webhook. La clave se guarda
 * cifrada (AES-256-GCM ligada a este negocio y canal) y no vuelve a salir del servidor.
 */
export async function connectChannel(
  db: Database,
  deps: TemplateGraphDeps,
  ctx: PanelContext,
  raw: unknown,
): Promise<Success<{ displayPhone: string | null; verifiedName: string | null }> | Failure<ChannelError> | (Failure<"invalid"> & { details: string[] })> {
  if (!can(ctx.role, "configure")) return fail("forbidden");
  const parsed = connectSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid", details: parsed.error.issues.map((i) => i.message) };
  const input = parsed.data;

  const admin = new GraphAdminClient({ accessToken: input.accessToken, apiVersion: deps.apiVersion, baseUrl: deps.baseUrl, fetch: deps.fetch });
  let phone: Awaited<ReturnType<GraphAdminClient["getPhoneNumber"]>>;
  try {
    phone = await admin.getPhoneNumber(input.phoneNumberId);
    await admin.subscribeApp(input.wabaId);
  } catch (error) {
    const f = metaFailure(error);
    if (f) return f;
    throw error;
  }

  try {
    await withTenant(db, scope(ctx), async (tx) => {
      const [existing] = await tx.select().from(channels).where(eq(channels.type, "whatsapp")).limit(1);
      const channelId = existing?.id ?? randomUUID();
      const values = {
        externalId: input.phoneNumberId,
        wabaId: input.wabaId,
        displayPhone: phone.displayPhone,
        qualityRating: phone.qualityRating,
        credentialsEnc: sealChannelCredentials({ accessToken: input.accessToken }, deps.key, ctx.tenantId, channelId),
        status: "active" as const,
        updatedAt: new Date(),
      };
      if (existing) await tx.update(channels).set(values).where(eq(channels.id, channelId));
      else await tx.insert(channels).values({ id: channelId, tenantId: ctx.tenantId, type: "whatsapp", ...values });
      await tx.insert(auditLog).values({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: "channel.connect",
        entity: "channel",
        entityId: channelId,
        // Nunca la clave: solo que numero se conecto.
        diff: { phoneNumberId: input.phoneNumberId, wabaId: input.wabaId } as never,
      });
    });
  } catch (error) {
    // Ese numero ya esta conectado en OTRO negocio (indice unico global).
    if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "23505") return fail("already_connected");
    const cause = (error as { cause?: { code?: string } } | null)?.cause;
    if (cause?.code === "23505") return fail("already_connected");
    throw error;
  }
  return { ok: true, displayPhone: phone.displayPhone, verifiedName: phone.verifiedName };
}

/** Pausa el canal y borra la clave guardada: deja de enviar y de aceptar mensajes. Solo dueño. */
export async function disconnectChannel(db: Database, ctx: PanelContext): Promise<Success | Failure<ChannelError>> {
  if (!can(ctx.role, "configure")) return fail("forbidden");
  return withTenant(db, scope(ctx), async (tx) => {
    const [c] = await tx.select().from(channels).where(and(eq(channels.type, "whatsapp"))).limit(1);
    if (!c) return fail("no_channel");
    await tx.update(channels).set({ credentialsEnc: null, status: "paused", updatedAt: new Date() }).where(eq(channels.id, c.id));
    await tx.insert(auditLog).values({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "channel.disconnect",
      entity: "channel",
      entityId: c.id,
    });
    return { ok: true as const };
  });
}
