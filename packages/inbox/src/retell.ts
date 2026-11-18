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
  /** Modelo de lenguaje del agente. Sin valor, Retell usa el suyo por defecto (de los mas caros). */
  model?: string;
}

export interface RetellAgentInput {
  agent_name: string;
  llm_id: string;
  voice_id: string;
  language: string;
  webhook_url: string;
  /** Tope de duracion de una llamada (ms). Retell: 60,000 a 7,200,000; por defecto 1 hora. */
  max_call_duration_ms?: number;
  /** Cuelga tras tanto silencio (ms). Retell: minimo 10,000; por defecto 10 minutos. */
  end_call_after_silence_ms?: number;
}

/**
 * Ajustes para que las llamadas cuesten menos (la voz es lo mas caro del sistema; ver docs/COSTOS-PRODUCTO.md):
 *  - RETELL_LLM_MODEL: modelo de lenguaje del agente. Por defecto "gpt-5.4-mini" (chico y con herramientas). Puedes poner
 *    "gpt-5-nano" o "gemini-3.5-flash-lite" (mas baratos) o "claude-5.5-haiku". Vacio o "default" = el de Retell.
 *  - VOICE_MAX_CALL_MINUTES: tope por llamada (1 a 120; por defecto 10).
 *  - VOICE_SILENCE_SECONDS: cuelga tras tanto silencio (10 a 600; por defecto 20).
 * Un valor fuera de rango se ignora y se usa el de por defecto.
 */
export function voiceCostSettings(env: Record<string, string | undefined>): { model?: string; maxCallMs: number; silenceMs: number } {
  const int = (v: string | undefined, min: number, max: number, fallback: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  };
  // Sin variable: modelo economico recomendado. Vacia o "default": el de Retell. Con un nombre mal escrito: el recomendado.
  const raw = env.RETELL_LLM_MODEL?.trim();
  let model: string | undefined = "gpt-5.4-mini";
  if (raw !== undefined) {
    if (raw === "" || raw.toLowerCase() === "default") model = undefined;
    else if (/^[a-z0-9.-]{2,40}$/i.test(raw)) model = raw;
  }
  return {
    model,
    maxCallMs: int(env.VOICE_MAX_CALL_MINUTES, 1, 120, 10) * 60_000,
    silenceMs: int(env.VOICE_SILENCE_SECONDS, 10, 600, 20) * 1000,
  };
}

export interface RetellVoice {
  id: string;
  name: string;
  provider?: string;
  gender?: string;
  accent?: string;
  age?: string;
  previewUrl?: string;
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

  /** Voces disponibles en la cuenta de Retell (para el desplegable del panel). */
  async listVoices(): Promise<RetellVoice[]> {
    const r = await this.call<unknown>("GET", "/list-voices");
    if (!Array.isArray(r)) return [];
    const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    return r
      .map((v): RetellVoice | null => {
        const o = (v ?? {}) as Record<string, unknown>;
        const id = s(o.voice_id);
        if (!id) return null;
        return {
          id,
          name: s(o.voice_name) ?? id,
          provider: s(o.provider),
          gender: s(o.gender),
          accent: s(o.accent),
          age: s(o.age),
          previewUrl: s(o.preview_audio_url),
        };
      })
      .filter((v): v is RetellVoice => v !== null);
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
      ...(input.max_call_duration_ms ? { max_call_duration_ms: input.max_call_duration_ms } : {}),
      ...(input.end_call_after_silence_ms ? { end_call_after_silence_ms: input.end_call_after_silence_ms } : {}),
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
      ...(input.max_call_duration_ms ? { max_call_duration_ms: input.max_call_duration_ms } : {}),
      ...(input.end_call_after_silence_ms ? { end_call_after_silence_ms: input.end_call_after_silence_ms } : {}),
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
