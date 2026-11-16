export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; /** JSON como texto, tal cual lo devuelve el modelo. */ arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema de los argumentos. */
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  /** Se usa solo si el modelo principal falla por un error transitorio (red, 429, 5xx). */
  fallbackModel?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /**
   * "deny" pide a OpenRouter enrutar solo a proveedores que no retienen ni entrenan con los
   * datos. Obligatorio para negocios de salud.
   */
  dataCollection?: "allow" | "deny";
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** Costo real reportado por OpenRouter, en dolares. */
  costUsd: number;
}

export interface ChatResponse {
  message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] };
  usage: Usage;
  /** Modelo que realmente respondio (puede ser el de respaldo). */
  model: string;
  usedFallback: boolean;
  finishReason: string | null;
}

export interface LLMProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly options: {
      status?: number;
      retryable: boolean;
      /** Segundos que pidio esperar el proveedor (cabecera Retry-After), en ms. */
      retryAfterMs?: number;
      /** El limite es diario: esperar unos segundos no sirve. */
      dailyLimit?: boolean;
    },
  ) {
    super(message);
    this.name = "LLMError";
  }
  get status(): number | undefined {
    return this.options.status;
  }
  get retryAfterMs(): number | undefined {
    return this.options.retryAfterMs;
  }
  get dailyLimit(): boolean {
    return this.options.dailyLimit ?? false;
  }
  get retryable(): boolean {
    return this.options.retryable;
  }
}
