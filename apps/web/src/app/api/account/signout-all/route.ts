import { signOutEverywhere } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { getDb } from "@/lib/server";
import { endSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Cierra la sesion en TODOS los dispositivos (sube la version de sesiones del usuario). */
export const POST = authed(
  async (_req, ctx) => {
    await signOutEverywhere(getDb(), ctx.userId);
    await endSession();
    return NextResponse.json({ ok: true });
  },
  { allowWhileMustChange: true },
);
