import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { getRetell } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Voces disponibles en Retell para el desplegable de Ajustes → Llamadas (cualquier persona con sesion). */
export const GET = authed(async () => {
  const retell = getRetell();
  if (!retell) return NextResponse.json({ ok: true, voices: [] });
  try {
    return NextResponse.json({ ok: true, voices: await retell.listVoices() });
  } catch {
    return NextResponse.json({ ok: false, message: "No se pudo consultar la lista de voces de Retell." }, { status: 502 });
  }
});
