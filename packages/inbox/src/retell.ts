import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Cliente minimo de Retell AI (agentes de voz). Docs: https://docs.retellai.com
 * IMPORTANTE: escrito con la API publica de Retell; los nombres de campos se deben confirmar con una
 * primera sincronizacion real (la API de Retell evoluciona).
 */
export interface RetellOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class RetellError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface RetellTool {
  type: "custom" | "end_call" | "transfer_call";
  /** Solo "transfer_call". */
  transfer_destination?: { type: "predefined"; number: string };
  transfer_option?: Record<string, unknown>;
  name: string;
  description: string;
  /** Solo "custom": a donde llama Retell cuando el modelo usa la herramienta. */
  url?: string;
  parameters?: Record<string, unknown>;
  timeout_ms?: number;
  speak_during_execution?: boolean;
  speak_after_execution?: boolean;
}

export interface RetellLlmInput {
  general_prompt: string;
  begin_message: string;
  general_tools: RetellTool[];
}

export interface RetellAgentInput {
  agent_name: string;
  llm_id: string;
  voice_id: string;
  language: string;
  webhook_url: string;
}

export class RetellClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: RetellOptions) {
    if (!options.apiKey) throw new Error("Falta RETELL_API_KEY");
    this.base = (options.baseUrl ?? "https://api.retellai.com").replace(/\/$/, "");
    this.doFetch = options.fetch ?? fetch;
  }

  private async call<T>(method: "POST" | "PATCH" | "GET", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new RetellError("sin conexion con Retell", 0);
    }
    const json = (await res.json().catch(() => ({}))) as T & { message?: string; error_message?: string };
    if (!res.ok) throw new RetellError(json.message ?? json.error_message ?? `Retell respondio ${res.status}`, res.status);
    return json;
  }

  async createLlm(input: RetellLlmInput): Promise<{ llmId: string }> {
    const r = await this.call<{ llm_id?: string }>("POST", "/create-retell-llm", { ...input, start_speaker: "agent" });
    if (!r.llm_id) throw new RetellError("Retell no devolvio el id del modelo", 502);
    return { llmId: r.llm_id };
  }

  async updateLlm(llmId: string, input: RetellLlmInput): Promise<void> {
    await this.call("PATCH", `/update-retell-llm/${encodeURIComponent(llmId)}`, input);
  }

  async createAgent(input: RetellAgentInput): Promise<{ agentId: string }> {
    const r = await this.call<{ agent_id?: string }>("POST", "/create-agent", {
      agent_name: input.agent_name,
      response_engine: { type: "retell-llm", llm_id: input.llm_id },
      voice_id: input.voice_id,
      language: input.language,
      webhook_url: input.webhook_url,
    });
    if (!r.agent_id) throw new RetellError("Retell no devolvio el id del agente", 502);
    return { agentId: r.agent_id };
  }

  async updateAgent(agentId: string, input: RetellAgentInput): Promise<void> {
    await this.call("PATCH", `/update-agent/${encodeURIComponent(agentId)}`, {
      agent_name: input.agent_name,
      response_engine: { type: "retell-llm", llm_id: input.llm_id },
      voice_id: input.voice_id,
      language: input.language,
      webhook_url: input.webhook_url,
    });
  }
}

/**
 * Verifica la firma que Retell pone en cada aviso y en cada llamada a una funcion.
 * Cabecera `x-retell-signature` = "v=<marca de tiempo>,d=<HMAC-SHA256 hex de (cuerpo + marca de tiempo)>"
 * con la clave de API de Retell. Se rechaza una firma de mas de 5 minutos (repeticion). Tambien se acepta
 * el formato anterior (HMAC hex del cuerpo, sin marca de tiempo).
 */
export function verifyRetellSignature(input: { body: string; apiKey: string; signature: string | null; now?: number }): boolean {
  const { body, apiKey, signature } = input;
  if (!apiKey || !signature) return false;
  const safeEq = (a: string, b: string) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };

  const m = /^v=(\d+),d=([0-9a-f]+)$/i.exec(signature.trim());
  if (m) {
    const ts = m[1]!;
    const tsMs = ts.length <= 10 ? Number(ts) * 1000 : Number(ts);
    if (Math.abs((input.now ?? Date.now()) - tsMs) > 5 * 60_000) return false;
    return safeEq(createHmac("sha256", apiKey).update(body + ts).digest("hex"), m[2]!.toLowerCase());
  }
  return safeEq(createHmac("sha256", apiKey).update(body).digest("hex"), signature.trim().toLowerCase());
}
