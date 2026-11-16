import { canSwitchTo } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed, failure, readJson, str } from "@/lib/api";
import { getDb } from "@/lib/server";
import { startSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Cambia de negocio: solo a uno al que el usuario pertenece (se comprueba en la base de datos). */
export const POST = authed(async (req, ctx, _params, session) => {
  const target = await canSwitchTo(getDb(), ctx.userId, str((await readJson(req)).tenantId));
  if (!target) return failure("not_found");
  await startSession({ uid: session.uid, tid: target.tenantId, sv: session.sv });
  return NextResponse.json({ ok: true });
});
