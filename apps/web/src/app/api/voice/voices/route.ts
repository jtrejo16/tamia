import { NextResponse } from "next/server";
import { authed } from "@/lib/api";
import { getRetell } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * Voces ofrecidas en Ajustes → Llamadas: una seleccion corta de voces mexicanas (2 mujeres, 2 hombres) en vez de
 * las ~350 de Retell. Son voces propias de Retell o preestablecidas, con acento mexicano. Solo se ofrecen las que
 * existen hoy en la cuenta (si Retell retira una, simplemente deja de aparecer).
 */
const FEATURED = [
  { id: "retell-Andrea", label: "Andrea — mujer, mexicana, adulta" },
  { id: "retell-Gaby", label: "Gaby — mujer, mexicana, joven" },
  { id: "retell-Alejandro", label: "Alejandro — hombre, mexicano, joven" },
  { id: "cartesia-Miguel", label: "Miguel — hombre, mexicano, adulto" },
];

/** Cualquier persona con sesion puede ver la lista. */
export const GET = authed(async () => {
  const retell = getRetell();
  if (!retell) return NextResponse.json({ ok: true, voices: [] });
  try {
    const all = new Map((await retell.listVoices()).map((v) => [v.id, v]));
    const voices = FEATURED.flatMap((f) => {
      const v = all.get(f.id);
      return v ? [{ id: f.id, name: f.label, previewUrl: v.previewUrl }] : [];
    });
    return NextResponse.json({ ok: true, voices });
  } catch {
    return NextResponse.json({ ok: false, message: "No se pudo consultar la lista de voces de Retell." }, { status: 502 });
  }
});
