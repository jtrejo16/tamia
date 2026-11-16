import {
  LLMError,
  type ChatRequest,
  type ChatResponse,
  type LLMProvider,
  type ToolCall,
} from "./types";

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl?: string;
  /** Inyectable para pruebas. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Cabeceras opcionales que OpenRouter usa para atribuir el trafico. */
  appUrl?: string;
  appName?: string;
  /** Veces que se reintenta el MISMO modelo tras un 429 (limite de velocidad). Por defecto 0. */
  rateLimitRetries?: number;
  /** Espera base entre reintentos (ms) si el proveedor no indica Retry-After. */
  retryDelayMs?: number;
  /** Inyectable para pruebas. */
  sleep?: (ms: number) => Promise<void>;
}

const MAX_WAIT_MS = 20_000;

interface RawResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { role?: string; content?: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { code?: number | string; message?: string };
}

/** Proveedor de OpenRouter (API compatible con OpenAI) con modelo de respaldo. */
export class OpenRouterProvider implements LLMProvider {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenRouterOptions) {
    if (!options.apiKey) throw new Error("Falta OPENROUTER_API_KEY");
    this.baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.doFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 45_000;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    try {
      return await this.callWithRetry(request.model, request, false);
    } catch (error) {
      const canFallback =
        error instanceof LLMError &&
        error.retryable &&
        request.fallbackModel &&
        request.fallbackModel !== request.model;
      if (!canFallback) throw error;
      return this.callWithRetry(request.fallbackModel!, request, true);
    }
  }

  /** Reintenta el mismo modelo ante un 429 de velocidad (no ante un limite diario). */
  private async callWithRetry(
    model: string,
    request: ChatRequest,
    usedFallback: boolean,
  ): Promise<ChatResponse> {
    const maxRetries = this.options.rateLimitRetries ?? 0;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callModel(model, request, usedFallback);
      } catch (error) {
        const retry =
          error instanceof LLMError && error.status === 429 && !error.dailyLimit && attempt < maxRetries;
        if (!retry) throw error;
        const wait = (error as LLMError).retryAfterMs ?? (this.options.retryDelayMs ?? 3000) * (attempt + 1);
        await sleep(Math.min(wait, MAX_WAIT_MS));
      }
    }
  }

  private async callModel(
    model: string,
    request: ChatRequest,
    usedFallback: boolean,
  ): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model,
      messages: request.messages,
      temperature: request.temperature ?? 0.3,
      usage: { include: true },
    };
    if (request.maxTokens) body.max_tokens = request.maxTokens;
    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = "auto";
    }
    if (request.dataCollection === "deny") body.provider = { data_collection: "deny" };

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;

    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
          ...(this.options.appUrl ? { "HTTP-Referer": this.options.appUrl } : {}),
          ...(this.options.appName ? { "X-Title": this.options.appName } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      // Red caida o timeout: transitorio. Nunca se incluyen cabeceras en el mensaje.
      const reason = e instanceof Error ? e.name : "error";
      throw new LLMError(`Fallo de red con OpenRouter (${reason})`, { retryable: true });
    }

    const text = await response.text();
    let json: RawResponse;
    try {
      json = JSON.parse(text) as RawResponse;
    } catch {
      throw new LLMError(`Respuesta no valida de OpenRouter (HTTP ${response.status})`, {
        status: response.status,
        retryable: response.status >= 500,
      });
    }

    if (!response.ok || json.error) {
      const status = response.ok ? Number(json.error?.code) || undefined : response.status;
      const retryable = status === undefined || status === 408 || status === 429 || status >= 500;
      const detail = json.error?.message ?? "sin detalle";
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      throw new LLMError(
        `OpenRouter rechazo la peticion${status ? ` (${status})` : ""}: ${detail}`,
        {
          status,
          retryable,
          ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? { retryAfterMs: retryAfterSeconds * 1000 }
            : {}),
          // "free-models-per-day": agotaste la cuota gratuita del dia; esperar segundos no ayuda.
          dailyLimit: /per[- ]day/i.test(detail),
        },
      );
    }

    const choice = json.choices?.[0];
    if (!choice?.message) {
      throw new LLMError("OpenRouter devolvio una respuesta vacia", { retryable: true });
    }

    const toolCalls = choice.message.tool_calls?.length ? choice.message.tool_calls : undefined;
    return {
      message: {
        role: "assistant",
        content: choice.message.content ?? null,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        costUsd: json.usage?.cost ?? 0,
      },
      model: json.model ?? model,
      usedFallback,
      finishReason: choice.finish_reason ?? null,
    };
  }
}
