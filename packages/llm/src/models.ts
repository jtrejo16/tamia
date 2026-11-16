/**
 * Lista blanca de modelos: solo los que probamos con la suite de conversaciones y que
 * manejan bien tool calling. El cliente elige un NIVEL, no entre cientos de modelos.
 * IDs verificados contra https://openrouter.ai/api/v1/models (nov-2026).
 */
export type ModelTier = "economico" | "balanceado" | "premium";

export interface TierConfig {
  model: string;
  /** Respaldo si el principal falla. Mas capaz que el principal, nunca mas barato y debil. */
  fallback: string;
  label: string;
}

export const MODEL_TIERS: Record<ModelTier, TierConfig> = {
  economico: {
    model: "anthropic/claude-haiku-5.5",
    fallback: "anthropic/claude-sonnet-5.5",
    label: "Económico",
  },
  balanceado: {
    model: "anthropic/claude-sonnet-5.5",
    fallback: "anthropic/claude-haiku-5.5",
    label: "Balanceado",
  },
  premium: {
    model: "anthropic/claude-opus-5.5",
    fallback: "anthropic/claude-sonnet-5.5",
    label: "Premium",
  },
};

/**
 * MODO GRATUITO (solo desarrollo y pruebas). Reemplaza TODOS los modelos por estos, sea cual
 * sea el nivel configurado del negocio. Verificados en OpenRouter: gratis y con tool calling.
 *
 * Compromisos que hay que conocer:
 *  - Limites: ~20 peticiones/minuto y 50 al dia (1000 si la cuenta tiene $10 de saldo).
 *    El agente hace de 2 a 5 llamadas por mensaje.
 *  - Privacidad: los proveedores gratuitos pueden registrar y usar los mensajes. NUNCA se
 *    deben usar con datos reales de clientes o pacientes.
 *  - Calidad y estabilidad menores que los modelos de pago; los modelos gratuitos cambian.
 */
export const FREE_MODELS = {
  primary: "google/gemma-4-31b-it:free",
  fallback: "nvidia/nemotron-3-ultra-550b-a55b:free",
} as const;

export type LlmMode = "paid" | "free";

/** Lee LLM_MODE. Vacio = paid. Un valor desconocido es un error (no se adivina). */
export function parseLlmMode(value: string | undefined): LlmMode {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || v === "paid") return "paid";
  if (v === "free") return "free";
  throw new Error(`LLM_MODE invalido: "${value}". Usa "paid" o "free".`);
}

/** Modelo barato y rapido para tareas internas: resumir memoria, clasificar intencion. */
export const UTILITY_MODEL = "anthropic/claude-haiku-5.5";

export const APPROVED_MODELS: ReadonlySet<string> = new Set([
  ...Object.values(MODEL_TIERS).flatMap((t) => [t.model, t.fallback]),
  UTILITY_MODEL,
]);

export function isApprovedModel(id: string): boolean {
  return APPROVED_MODELS.has(id);
}

export function assertApprovedModel(id: string): void {
  if (!isApprovedModel(id)) {
    throw new Error(
      `Modelo no aprobado: "${id}". Aprobados: ${[...APPROVED_MODELS].join(", ")}`,
    );
  }
}

/** Verticales cuyos datos son sensibles: se exige proveedores sin retencion de datos. */
const SENSITIVE_VERTICALS = new Set(["dental", "salud", "medico"]);

export function dataCollectionFor(vertical: string): "allow" | "deny" {
  return SENSITIVE_VERTICALS.has(vertical) ? "deny" : "allow";
}
