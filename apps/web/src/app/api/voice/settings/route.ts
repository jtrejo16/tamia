import { getVoiceSettings, saveVoiceSettings } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed, readJson, respond } from "@/lib/api";
import { getDb, getRetell } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = authed(async (_req, ctx) =>
  NextResponse.json({ ok: true, settings: await getVoiceSettings(getDb(), ctx, getRetell() !== null) }),
);

/** Guarda los ajustes de voz. Solo dueño (lo valida el dominio). */
export const POST = authed(async (req, ctx) => respond(await saveVoiceSettings(getDb(), ctx, await readJson(req))));
