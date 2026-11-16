import { FREE_MODELS, parseLlmMode, type LlmMode } from "./models";
import { OpenRouterProvider } from "./openrouter";
import type { ChatRequest, ChatResponse, LLMProvider } from "./types";

/**
 * Envuelve un proveedor y fuerza los modelos gratuitos, ignorando el que pida quien llama.
 * Asi el resto del sistema (runtime, memoria, evals) no cambia: solo cambia el proveedor.
 */
export class FreeModelProvider implements LLMProvider {
  constructor(
    private readonly inner: LLMProvider,
    private readonly models: { primary: string; fallback: string } = FREE_MODELS,
  ) {}

  chat(request: ChatRequest): Promise<ChatResponse> {
    return this.inner.chat({
      ...request,
      model: this.models.primary,
      fallbackModel: this.models.fallback,
      // "deny" excluiria a todos los proveedores gratuitos (ninguno garantiza no retener datos).
      dataCollection: "allow",
    });
  }
}

export interface CreateProviderOptions {
  apiKey: string;
  /** "paid" (por defecto) o "free". Normalmente viene de la variable LLM_MODE. */
  mode?: LlmMode | string;
  appName?: string;
  appUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Punto unico para crear el proveedor de IA segun el modo configurado. */
export function createLLMProvider(options: CreateProviderOptions): LLMProvider {
  const mode = parseLlmMode(options.mode);
  const base = new OpenRouterProvider({
    apiKey: options.apiKey,
    appName: options.appName,
    appUrl: options.appUrl,
    fetch: options.fetch,
    sleep: options.sleep,
    // Los modelos gratuitos se topan con el limite por minuto: se espera y se reintenta.
    rateLimitRetries: mode === "free" ? 3 : 0,
    retryDelayMs: 4000,
  });
  return mode === "free" ? new FreeModelProvider(base) : base;
}
