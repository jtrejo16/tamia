import { describe, expect, it, vi } from "vitest";
import {
  LLMError,
  MODEL_TIERS,
  OpenRouterProvider,
  assertApprovedModel,
  dataCollectionFor,
  isApprovedModel,
  type ChatRequest,
} from "../src";

const ok = (model = "anthropic/claude-haiku-5.5", content: string | null = "Hola") =>
  new Response(
    JSON.stringify({
      model,
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.00003 },
    }),
    { status: 200 },
  );

const failure = (status: number, message = "boom") =>
  new Response(JSON.stringify({ error: { code: status, message } }), { status });

const request = (extra: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "anthropic/claude-haiku-5.5",
  fallbackModel: "anthropic/claude-sonnet-5.5",
  messages: [{ role: "user", content: "Hola" }],
  ...extra,
});

function provider(fetchImpl: typeof fetch) {
  return new OpenRouterProvider({ apiKey: "sk-test", fetch: fetchImpl });
}

describe("OpenRouterProvider", () => {
  it("devuelve el mensaje, los tokens y el costo real", async () => {
    const res = await provider(vi.fn().mockResolvedValue(ok())).chat(request());
    expect(res.message.content).toBe("Hola");
    expect(res.usage).toEqual({ promptTokens: 100, completionTokens: 20, costUsd: 0.00003 });
    expect(res.usedFallback).toBe(false);
  });

  it("envia modelo, herramientas y pide el costo (usage.include)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    const tools = [
      { type: "function" as const, function: { name: "t", description: "d", parameters: {} } },
    ];
    await provider(fetchMock).chat(request({ tools }));
    const [url, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(body.model).toBe("anthropic/claude-haiku-5.5");
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe("auto");
    expect(body.usage).toEqual({ include: true });
    expect(init.headers.Authorization).toBe("Bearer sk-test");
  });

  it("dataCollection=deny pide proveedores sin retencion de datos", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    await provider(fetchMock).chat(request({ dataCollection: "deny" }));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).provider).toEqual({ data_collection: "deny" });
  });

  it("devuelve las llamadas a herramientas del modelo", async () => {
    const toolCall = { id: "c1", type: "function", function: { name: "consultar_servicios", arguments: "{}" } };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "m",
          choices: [{ message: { role: "assistant", content: null, tool_calls: [toolCall] }, finish_reason: "tool_calls" }],
        }),
      ),
    );
    const res = await provider(fetchMock).chat(request());
    expect(res.message.tool_calls).toEqual([toolCall]);
    expect(res.message.content).toBeNull();
  });

  it("usa el modelo de respaldo ante un 503", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failure(503))
      .mockResolvedValueOnce(ok("anthropic/claude-sonnet-5.5"));
    const res = await provider(fetchMock).chat(request());
    expect(res.usedFallback).toBe(true);
    expect(res.model).toBe("anthropic/claude-sonnet-5.5");
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).model).toBe("anthropic/claude-sonnet-5.5");
  });

  it("usa el respaldo ante 429, timeout o red caida", async () => {
    for (const first of [
      () => Promise.resolve(failure(429)),
      () => Promise.reject(new DOMException("timeout", "TimeoutError")),
      () => Promise.reject(new TypeError("fetch failed")),
    ]) {
      const fetchMock = vi.fn().mockImplementationOnce(first).mockResolvedValueOnce(ok());
      const res = await provider(fetchMock).chat(request());
      expect(res.usedFallback).toBe(true);
    }
  });

  it("trata un error dentro de un 200 como fallo transitorio", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 502, message: "upstream" } })))
      .mockResolvedValueOnce(ok());
    expect((await provider(fetchMock).chat(request())).usedFallback).toBe(true);
  });

  it("NO usa respaldo en errores permanentes (401 llave invalida, 400)", async () => {
    for (const status of [401, 400, 402]) {
      const fetchMock = vi.fn().mockResolvedValue(failure(status));
      await expect(provider(fetchMock).chat(request())).rejects.toMatchObject({ status, retryable: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("si el respaldo tambien falla, lanza el error", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(failure(500)));
    await expect(provider(fetchMock).chat(request())).rejects.toBeInstanceOf(LLMError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sin respaldo configurado, un 503 se propaga", async () => {
    const fetchMock = vi.fn().mockResolvedValue(failure(503));
    await expect(provider(fetchMock).chat(request({ fallbackModel: undefined }))).rejects.toBeInstanceOf(LLMError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("los mensajes de error no filtran la llave", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const err = await provider(fetchMock).chat(request({ fallbackModel: undefined })).catch((e) => e as Error);
    expect(String(err.message)).not.toContain("sk-test");
  });

  it("exige llave", () => {
    expect(() => new OpenRouterProvider({ apiKey: "" })).toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("modelos aprobados", () => {
  it("todos los niveles usan modelos aprobados y el respaldo es distinto del principal", () => {
    for (const tier of Object.values(MODEL_TIERS)) {
      expect(isApprovedModel(tier.model)).toBe(true);
      expect(isApprovedModel(tier.fallback)).toBe(true);
      expect(tier.fallback).not.toBe(tier.model);
    }
  });

  it("rechaza modelos fuera de la lista", () => {
    expect(() => assertApprovedModel("random/modelo-barato")).toThrow(/no aprobado/i);
  });

  it("salud/dental exige proveedores sin retencion de datos", () => {
    expect(dataCollectionFor("dental")).toBe("deny");
    expect(dataCollectionFor("seguros")).toBe("allow");
  });
});
