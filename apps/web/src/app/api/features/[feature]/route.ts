import {
  createFeatureTemplate,
  emailDepsFromEnv,
  getNotificationSettings,
  getReviewSettings,
  saveNotificationSettings,
  saveReviewSettings,
} from "@empleado/inbox";
import { parseKey } from "@empleado/shared";
import { NextResponse } from "next/server";
import { authed, failure, readJson, respond } from "@/lib/api";
import { env, getDb } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Para hablar con Meta: la llave abre el token del canal (nunca sale del servidor). */
const graph = () => ({
  key: parseKey(env("ENCRYPTION_KEY")),
  apiVersion: process.env.GRAPH_API_VERSION || "v23.0",
  baseUrl: process.env.GRAPH_BASE_URL || undefined,
});

/**
 *  GET  /api/features/avisos | resenas   → ajustes actuales
 *  POST /api/features/avisos | resenas   → guarda (solo dueño) y, si hace falta, pide a Meta la plantilla
 */
export const GET = authed<{ feature: string }>(async (_req, ctx, { feature }) => {
  if (feature === "avisos") {
    return NextResponse.json({ ok: true, settings: await getNotificationSettings(getDb(), ctx), emailAvailable: emailDepsFromEnv(process.env) !== null });
  }
  if (feature === "resenas") return NextResponse.json({ ok: true, settings: await getReviewSettings(getDb(), ctx) });
  return failure("not_found");
});

export const POST = authed<{ feature: string }>(async (req, ctx, { feature }) => {
  if (feature !== "avisos" && feature !== "resenas") return failure("not_found");
  const body = await readJson(req);
  const saved = feature === "avisos" ? await saveNotificationSettings(getDb(), ctx, body) : await saveReviewSettings(getDb(), ctx, body);
  if (!saved.ok) return respond(saved);

  // Al encender, se pide a Meta la plantilla (idempotente). Si Meta falla, los ajustes quedan guardados y se avisa.
  let template: { created: string[]; existing: string[] } | { error: string; details?: string } | null = null;
  if (saved.needsTemplate) {
    const r = await createFeatureTemplate(getDb(), graph(), ctx, feature);
    template = r.ok ? { created: r.created, existing: r.existing } : { error: r.error, ...("details" in r && r.details ? { details: r.details } : {}) };
  }
  return NextResponse.json({ ok: true, template });
});
