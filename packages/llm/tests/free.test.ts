import { describe, expect, it, vi } from "vitest";
import {
  FREE_MODELS,
  FreeModelProvider,
  LLMError,
  OpenRouterProvider,
  createLLMProvider,
  parseLlmMode,
  type ChatRequest,
  type LLMProvider,
} from "../src";

const ok = () =>
  new Response(
    JSON.stringify({
      model: "x",
      choices: [{ message: { role: "assistant", content: "hola" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 },
    }),
  );
const rateLimited = (message = "Rate limit exceeded: limit_rpm", headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code: 429, message } }), { status: 429, headers });

const paidRequest: ChatRequest = {
  model: "anthropic/claude-sonnet-5.5",
  fallbackModel: "anthropic/claude-haiku-5.5",
  messages: [{ role: "user", content: "Hola" }],
  dataCollection: "deny",
  tools: [{ type: "function", function: { name: "t", description: "d", parameters: {} } }],
};

describe("modo gratuito", () => {
  it("los modelos gratuitos terminan en :free (nunca cobran por accidente)", () => {
    expect(FREE_MODELS.primary.endsWith(":free")).toBe(true);
    expect(FREE_MODELS.fallback.endsWith(":free")).toBe(true);
    expect(FREE_MODELS.primary).not.toBe(FREE_MODELS.fallback);
  });

  it("reemplaza cualquier modelo pedido por los gratuitos y conserva mensajes y herramientas", async () => {
    const chat = vi.fn().mockResolvedValue({});
    const inner: LLMProvider = { chat };
    await new FreeModelProvider(inner).chat(paidRequest);
    const sent = chat.mock.calls[0]![0] as ChatRequest;
    expect(sent.model).toBe(FREE_MODELS.primary);
    expect(sent.fallbackModel).toBe(FREE_MODELS.fallback);
    expect(sent.messages).toEqual(paidRequest.messages);
    expect(sent.tools).toEqual(paidRequest.tools);
  });

  it("no exige 'deny' en datos (ningun proveedor gratuito lo garantiza)", async () => {
    const chat = vi.fn().mockResolvedValue({});
    await new FreeModelProvider({ chat }).chat(paidRequest);
    expect((chat.mock.calls[0]![0] as ChatRequest).dataCollection).toBe("allow");
  });

  it("la fabrica devuelve el proveedor de pago por defecto y el gratuito con mode=free", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(ok()));
    await createLLMProvider({ apiKey: "k", fetch: fetchMock }).chat(paidRequest);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).model).toBe("anthropic/claude-sonnet-5.5");

    await createLLMProvider({ apiKey: "k", mode: "free", fetch: fetchMock }).chat(paidRequest);
    const body = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(body.model).toBe(FREE_MODELS.primary);
    expect(body.provider).toBeUndefined();
  });

  it("LLM_MODE: vacio=paid, free=free y un valor raro es un error", () => {
    expect(parseLlmMode(undefined)).toBe("paid");
    expect(parseLlmMode("")).toBe("paid");
    expect(parseLlmMode(" FREE ")).toBe("free");
    expect(() => parseLlmMode("gratis")).toThrow(/LLM_MODE invalido/);
  });
});

describe("reintentos ante el limite de velocidad (429)", () => {
  const provider = (fetchImpl: typeof fetch, retries = 2) => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    return { sleep, p: new OpenRouterProvider({ apiKey: "k", fetch: fetchImpl, rateLimitRetries: retries, sleep }) };
  };

  it("espera y reintenta el MISMO modelo antes de pasar al respaldo", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(ok());
    const { p, sleep } = provider(fetchMock);
    const res = await p.chat(paidRequest);
    expect(res.usedFallback).toBe(false);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).model).toBe("anthropic/claude-sonnet-5.5");
  });

  it("respeta Retry-After del proveedor", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited("slow down", { "retry-after": "7" }))
      .mockResolvedValueOnce(ok());
    const { p, sleep } = provider(fetchMock);
    await p.chat(paidRequest);
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it("nunca espera mas de 20 segundos", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited("slow down", { "retry-after": "600" }))
      .mockResolvedValueOnce(ok());
    const { p, sleep } = provider(fetchMock);
    await p.chat(paidRequest);
    expect(sleep).toHaveBeenCalledWith(20_000);
  });

  it("agotados los reintentos, usa el modelo de respaldo", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(rateLimited()))
      .mockImplementationOnce(() => Promise.resolve(rateLimited()))
      .mockImplementationOnce(() => Promise.resolve(rateLimited()))
      .mockImplementation(() => Promise.resolve(ok()));
    const { p } = provider(fetchMock, 2);
    const res = await p.chat(paidRequest);
    expect(res.usedFallback).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 + 2 reintentos + 1 respaldo
  });

  it("un limite DIARIO no se reintenta con esperas (no sirve esperar segundos)", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(rateLimited("Rate limit exceeded: free-models-per-day")));
    const { p, sleep } = provider(fetchMock);
    const err = await p.chat({ ...paidRequest, fallbackModel: undefined }).catch((e) => e as LLMError);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as LLMError).dailyLimit).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sin reintentos configurados (modo pago) no espera: pasa directo al respaldo", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(rateLimited()))
      .mockImplementation(() => Promise.resolve(ok()));
    const { p, sleep } = provider(fetchMock, 0);
    const res = await p.chat(paidRequest);
    expect(res.usedFallback).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });
});
