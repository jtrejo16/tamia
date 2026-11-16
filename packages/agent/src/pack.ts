import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Pack de giro: todo lo tipico de una industria, versionado en /packs. */
export const packSchema = z.object({
  slug: z.string().min(1),
  version: z.string().min(1),
  vertical: z.string().min(1),
  title: z.string(),
  roleLabel: z.string().default("especialista"),
  requiredAppointmentData: z.string().default("nombre completo"),
  urgency: z
    .object({ criteria: z.string(), instruction: z.string() })
    .default({ criteria: "una emergencia", instruction: "pedirle que acuda de inmediato" }),
  extraEscalationRules: z.array(z.string()).default([]),
  instructions: z.string().default(""),
  sampleFaqs: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
  reminder: z.object({ monthsAfter: z.record(z.string(), z.number()) }).optional(),
});
export type Pack = z.infer<typeof packSchema>;

const cache = new Map<string, Pack>();

/**
 * Donde buscar packs/<slug>.json. En desarrollo esta junto al codigo, pero dentro de una imagen
 * compilada (panel de Next, contenedores) esa ruta relativa deja de existir: por eso se prueba, en
 * orden, PACKS_DIR (explicita), la carpeta de trabajo y la ruta relativa al codigo fuente.
 */
function findPackFile(slug: string): string {
  const candidates = [
    process.env.PACKS_DIR ? join(process.env.PACKS_DIR, `${slug}.json`) : null,
    join(process.cwd(), "packs", `${slug}.json`),
    join(process.cwd(), "..", "..", "packs", `${slug}.json`),
    (() => {
      try {
        return fileURLToPath(new URL(`../../../packs/${slug}.json`, import.meta.url));
      } catch {
        return null;
      }
    })(),
  ].filter((p): p is string => p !== null);
  return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1] ?? `packs/${slug}.json`;
}

/** Carga packs/<slug>.json desde la raiz del repositorio. */
export function loadPack(slug: string): Pack {
  if (!/^[a-z0-9_-]+$/.test(slug)) throw new Error(`Slug de pack invalido: "${slug}"`);
  const cached = cache.get(slug);
  if (cached) return cached;
  const path = findPackFile(slug);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`No existe el pack de giro "${slug}" (packs/${slug}.json)`);
  }
  const pack = packSchema.parse(JSON.parse(raw));
  cache.set(slug, pack);
  return pack;
}

/** Pack neutro para negocios sin pack asignado. */
export const GENERIC_PACK: Pack = packSchema.parse({
  slug: "generico",
  version: "0.0.0",
  vertical: "generico",
  title: "Negocio local",
});
