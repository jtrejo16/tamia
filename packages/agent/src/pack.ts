import { readFileSync } from "node:fs";
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

/** Carga packs/<slug>.json desde la raiz del repositorio. */
export function loadPack(slug: string): Pack {
  if (!/^[a-z0-9_-]+$/.test(slug)) throw new Error(`Slug de pack invalido: "${slug}"`);
  const cached = cache.get(slug);
  if (cached) return cached;
  const url = new URL(`../../../packs/${slug}.json`, import.meta.url);
  let raw: string;
  try {
    raw = readFileSync(url, "utf8");
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
