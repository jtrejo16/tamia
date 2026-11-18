import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_WEBHOOK_BYTES,
  WhatsAppApiError,
  WhatsAppClient,
  classifyGraphError,
  createWhatsAppWebhook,
  isWithinServiceWindow,
  openChannelCredentials,
  parseWebhookPayload,
  sealChannelCredentials,
  signBody,
  verifySignature,
  windowClosesAt,
  type WebhookDeps,
} from "../src";

const SECRET = "app-secret-de-prueba";
const PNID = "1385124751359472";

const envelope = (value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA",
      changes: [
        {
          field: "messages",
          value: { messaging_product: "whatsapp", metadata: { phone_number_id: PNID, display_phone_number: "5219844790350" }, ...value },
        },
      ],
    },
  ],
});

const textMessage = (id = "wamid.A1", body = "Hola") => ({
  contacts: [{ profile: { name: "Ana" }, wa_id: "5219841112222" }],
  messages: [{ from: "5219841112222", id, timestamp: "1767225600", type: "text", text: { body } }],
});

describe("firma X-Hub-Signature-256", () => {
  it("acepta la firma correcta", () => {
    const body = JSON.stringify(envelope(textMessage()));
    expect(verifySignature(body, signBody(body, SECRET), SECRET)).toBe(true);
  });

  it("rechaza firma ajena, cuerpo alterado, cabecera ausente o mal formada", () => {
    const body = JSON.stringify(envelope(textMessage()));
    const good = signBody(body, SECRET);
    expect(verifySignature(body, signBody(body, "otro-secreto"), SECRET)).toBe(false);
    expect(verifySignature(body + " ", good, SECRET)).toBe(false);
    expect(verifySignature(body, null, SECRET)).toBe(false);
    expect(verifySignature(body, "sha256=zzzz", SECRET)).toBe(false);
    expect(verifySignature(body, good.replace("sha256=", "sha1="), SECRET)).toBe(false);
    expect(verifySignature(body, "sha256=", SECRET)).toBe(false);
  });

  it("sin App Secret configurado nunca valida (no se acepta todo por omision)", () => {
    expect(verifySignature("{}", signBody("{}", ""), "")).toBe(false);
  });
});

describe("lectura del payload de Meta", () => {
  it("normaliza un texto con el nombre del perfil", () => {
    const parsed = parseWebhookPayload(envelope(textMessage("wamid.X", "¿Cuánto cuesta?")));
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toMatchObject({
      phoneNumberId: PNID,
      contactName: "Ana",
      message: { id: "wamid.X", from: "5219841112222", type: "text", text: "¿Cuánto cuesta?", timestamp: 1767225600 },
    });
  });

  it("normaliza imagen con leyenda, audio, documento y ubicacion", () => {
    const parsed = parseWebhookPayload(
      envelope({
        messages: [
          { from: "1", id: "i", type: "image", image: { id: "M1", mime_type: "image/jpeg", caption: "mi diente" } },
          { from: "1", id: "a", type: "audio", audio: { id: "M2", mime_type: "audio/ogg", voice: true } },
          { from: "1", id: "d", type: "document", document: { id: "M3", filename: "poliza.pdf" } },
          { from: "1", id: "l", type: "location", location: { latitude: 20.96, longitude: -89.62, name: "Casa" } },
        ],
      }),
    );
    const byId = Object.fromEntries(parsed.messages.map((m) => [m.message.id, m.message]));
    expect(byId.i).toMatchObject({ type: "image", text: "mi diente", mediaId: "M1", mimeType: "image/jpeg" });
    expect(byId.a).toMatchObject({ type: "audio", text: "", mediaId: "M2" });
    expect(byId.d).toMatchObject({ type: "document", text: "poliza.pdf" });
    expect(byId.l).toMatchObject({ type: "location", location: { latitude: 20.96, longitude: -89.62, name: "Casa" } });
    expect(byId.l!.text).toContain("Ubicación compartida");
  });

  it("toma el texto de botones y listas (respuestas rapidas de recordatorios)", () => {
    const parsed = parseWebhookPayload(
      envelope({
        messages: [
          { from: "1", id: "b1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "confirm", title: "Confirmo" } } },
          { from: "1", id: "b2", type: "button", button: { text: "Reagendar", payload: "resched" } },
        ],
      }),
    );
    expect(parsed.messages.map((m) => [m.message.text, m.message.replyPayload])).toEqual([
      ["Confirmo", "confirm"],
      ["Reagendar", "resched"],
    ]);
  });

  it("ignora reacciones, tipos desconocidos y mensajes sin id o sin cuerpo", () => {
    const parsed = parseWebhookPayload(
      envelope({
        messages: [
          { from: "1", id: "r", type: "reaction", reaction: { emoji: "👍" } },
          { from: "1", id: "u", type: "unsupported" },
          { from: "1", type: "text", text: { body: "sin id" } },
          { from: "1", id: "e", type: "text", text: { body: "" } },
        ],
      }),
    );
    expect(parsed.messages).toHaveLength(0);
    expect(parsed.ignored).toBe(4);
  });

  it("lee estados de entrega y errores", () => {
    const parsed = parseWebhookPayload(
      envelope({
        statuses: [
          { id: "wamid.S", status: "delivered", recipient_id: "5219841112222", timestamp: "1767225700" },
          { id: "wamid.F", status: "failed", timestamp: "1767225701", errors: [{ code: 131047, title: "Re-engagement", message: "Más de 24 h" }] },
          { id: "wamid.Z", status: "raro" },
        ],
      }),
    );
    expect(parsed.statuses).toHaveLength(2);
    expect(parsed.statuses[0]!.status).toMatchObject({ id: "wamid.S", status: "delivered", recipientId: "5219841112222" });
    expect(parsed.statuses[1]!.status).toMatchObject({ status: "failed", errorCode: 131047, errorTitle: "Re-engagement" });
    expect(parsed.ignored).toBe(1);
  });

  it("lee como cobra Meta cada mensaje (categoria y si se cobra)", () => {
    const parsed = parseWebhookPayload(
      envelope({
        statuses: [
          { id: "w1", status: "sent", pricing: { billable: true, pricing_model: "PMP", type: "regular", category: "service" } },
          { id: "w2", status: "delivered", pricing: { billable: false, pricing_model: "PMP", type: "free_customer_service", category: "service" } },
          { id: "w3", status: "sent", pricing: { billable: "si", category: "utility" } }, // dato mal formado: se ignora
          { id: "w4", status: "sent" },
        ],
      }),
    );
    expect(parsed.statuses.map((s) => s.status.pricing)).toEqual([
      { billable: true, category: "service", type: "regular" },
      { billable: false, category: "service", type: "free_customer_service" },
      undefined,
      undefined,
    ]);
  });

  it("tolera basura sin lanzar excepciones", () => {
    for (const junk of [null, 5, "x", [], {}, { object: "page" }, { object: "whatsapp_business_account", entry: "no" }, envelope({ messages: "no" })]) {
      expect(() => parseWebhookPayload(junk)).not.toThrow();
      expect(parseWebhookPayload(junk).messages).toEqual([]);
    }
  });

  it("procesa varios eventos en un mismo POST", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [envelope(textMessage("m1")).entry[0], envelope({ ...textMessage("m2"), statuses: [{ id: "s", status: "sent" }] }).entry[0]],
    };
    const parsed = parseWebhookPayload(payload);
    expect(parsed.messages.map((m) => m.message.id)).toEqual(["m1", "m2"]);
    expect(parsed.statuses).toHaveLength(1);
  });
});

describe("manejadores del webhook", () => {
  function setup(overrides: Partial<WebhookDeps> = {}) {
    const inbound = vi.fn().mockResolvedValue(undefined);
    const status = vi.fn().mockResolvedValue(undefined);
    const deps: WebhookDeps = {
      verifyToken: "mi-token",
      appSecret: SECRET,
      resolveChannel: vi.fn().mockResolvedValue({ tenantId: "t1", channelId: "c1" }),
      enqueueInbound: inbound,
      enqueueStatus: status,
      ...overrides,
    };
    return { hooks: createWhatsAppWebhook(deps), inbound, status, deps };
  }

  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request("https://x.test/webhook", { method: "POST", body, headers });
  const signed = (obj: unknown) => {
    const body = JSON.stringify(obj);
    return post(body, { "x-hub-signature-256": signBody(body, SECRET) });
  };

  it("GET verifica la URL devolviendo el challenge solo con el token correcto", async () => {
    const { hooks } = setup();
    const ok = await hooks.GET(new Request("https://x.test/webhook?hub.mode=subscribe&hub.verify_token=mi-token&hub.challenge=12345"));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345");

    for (const qs of [
      "hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1",
      "hub.mode=subscribe&hub.challenge=1",
      "hub.mode=unsubscribe&hub.verify_token=mi-token&hub.challenge=1",
      "",
    ]) {
      expect((await hooks.GET(new Request(`https://x.test/webhook?${qs}`))).status).toBe(403);
    }
  });

  it("POST sin firma o con firma falsa -> 401 y no se encola nada", async () => {
    const { hooks, inbound } = setup();
    const body = JSON.stringify(envelope(textMessage()));
    expect((await hooks.POST(post(body))).status).toBe(401);
    expect((await hooks.POST(post(body, { "x-hub-signature-256": signBody(body, "falso") }))).status).toBe(401);
    expect(inbound).not.toHaveBeenCalled();
  });

  it("POST firmado encola el mensaje con su negocio y canal y responde 200", async () => {
    const { hooks, inbound } = setup();
    const res = await hooks.POST(signed(envelope(textMessage("wamid.Q", "Hola"))));
    expect(res.status).toBe(200);
    expect(inbound).toHaveBeenCalledTimes(1);
    expect(inbound.mock.calls[0]![0]).toMatchObject({
      tenantId: "t1",
      channelId: "c1",
      phoneNumberId: PNID,
      contactName: "Ana",
      message: { id: "wamid.Q", text: "Hola" },
    });
  });

  it("encola los estados de entrega", async () => {
    const { hooks, status, inbound } = setup();
    await hooks.POST(signed(envelope({ statuses: [{ id: "wamid.S", status: "read" }] })));
    expect(status).toHaveBeenCalledTimes(1);
    expect(status.mock.calls[0]![0]).toMatchObject({ tenantId: "t1", channelId: "c1", status: { id: "wamid.S", status: "read" } });
    expect(inbound).not.toHaveBeenCalled();
  });

  it("un numero que no esta registrado se ignora con 200 (para que Meta no reintente)", async () => {
    const { hooks, inbound } = setup({ resolveChannel: vi.fn().mockResolvedValue(null) });
    expect((await hooks.POST(signed(envelope(textMessage())))).status).toBe(200);
    expect(inbound).not.toHaveBeenCalled();
  });

  it("consulta el canal una sola vez por numero aunque lleguen varios mensajes", async () => {
    const resolveChannel = vi.fn().mockResolvedValue({ tenantId: "t1", channelId: "c1" });
    const { hooks, inbound } = setup({ resolveChannel });
    const value = {
      messages: [
        { from: "1", id: "a", type: "text", text: { body: "uno" } },
        { from: "1", id: "b", type: "text", text: { body: "dos" } },
      ],
    };
    await hooks.POST(signed(envelope(value)));
    expect(inbound).toHaveBeenCalledTimes(2);
    expect(resolveChannel).toHaveBeenCalledTimes(1);
  });

  it("si falla la cola responde 500 para que Meta reintente", async () => {
    const { hooks } = setup({ enqueueInbound: vi.fn().mockRejectedValue(new Error("redis caido")) });
    expect((await hooks.POST(signed(envelope(textMessage())))).status).toBe(500);
  });

  it("JSON invalido pero bien firmado -> 400; cuerpo gigante -> 413", async () => {
    const { hooks } = setup();
    const bad = "no es json";
    expect((await hooks.POST(post(bad, { "x-hub-signature-256": signBody(bad, SECRET) }))).status).toBe(400);
    const big = "x".repeat(MAX_WEBHOOK_BYTES + 1);
    expect((await hooks.POST(post(big, { "x-hub-signature-256": signBody(big, SECRET) }))).status).toBe(413);
  });
});

describe("cliente de WhatsApp", () => {
  const ok = (id = "wamid.OUT") => new Response(JSON.stringify({ messages: [{ id }] }), { status: 200 });
  const err = (status: number, code: number, message = "boom") =>
    new Response(JSON.stringify({ error: { message, code } }), { status });
  const client = (fetchImpl: typeof fetch) =>
    new WhatsAppClient({ accessToken: "TOKEN-SECRETO", phoneNumberId: PNID, fetch: fetchImpl, apiVersion: "v23.0" });

  it("envia texto con el formato de la Cloud API y devuelve el wamid", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    const res = await client(fetchMock).sendText("5219841112222", "Hola Ana");
    expect(res.wamid).toBe("wamid.OUT");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://graph.facebook.com/v23.0/${PNID}/messages`);
    expect(init.headers.Authorization).toBe("Bearer TOKEN-SECRETO");
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "5219841112222",
      type: "text",
      text: { body: "Hola Ana", preview_url: false },
    });
  });

  it("envia ubicaciones", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    await client(fetchMock).sendLocation("1", { latitude: 20.96, longitude: -89.62, name: "Clínica", address: "Calle 60" });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({
      type: "location",
      location: { latitude: 20.96, longitude: -89.62, name: "Clínica", address: "Calle 60" },
    });
  });

  it("markRead usa status=read y nunca lanza", async () => {
    const fetchMock = vi.fn().mockResolvedValue(err(500, 1));
    await expect(client(fetchMock).markRead("wamid.IN")).resolves.toBeUndefined();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ status: "read", message_id: "wamid.IN" });
  });

  it("clasifica los errores de Meta en categorias accionables", () => {
    expect(classifyGraphError(401, 190)).toBe("auth");
    expect(classifyGraphError(400, 190)).toBe("auth");
    expect(classifyGraphError(400, 131047)).toBe("window");
    expect(classifyGraphError(400, 131030)).toBe("recipient");
    expect(classifyGraphError(400, 131026)).toBe("recipient");
    expect(classifyGraphError(429, undefined)).toBe("rate");
    expect(classifyGraphError(400, 130429)).toBe("rate");
    expect(classifyGraphError(503, undefined)).toBe("server");
    expect(classifyGraphError(undefined, undefined)).toBe("server");
    expect(classifyGraphError(400, 100)).toBe("other");
  });

  it("los errores traen categoria y solo los transitorios son reintentables", async () => {
    const cases: Array<[number, number, string, boolean]> = [
      [401, 190, "auth", false],
      [400, 131047, "window", false],
      [400, 131030, "recipient", false],
      [429, 130429, "rate", true],
      [500, 2, "server", true],
    ];
    for (const [status, code, kind, retryable] of cases) {
      const e = (await client(vi.fn().mockResolvedValue(err(status, code))).sendText("1", "x").catch((x) => x)) as WhatsAppApiError;
      expect(e).toBeInstanceOf(WhatsAppApiError);
      expect(e.kind).toBe(kind);
      expect(e.retryable).toBe(retryable);
    }
  });

  it("un fallo de red es transitorio y el mensaje no filtra el token", async () => {
    const e = (await client(vi.fn().mockRejectedValue(new TypeError("fetch failed"))).sendText("1", "x").catch((x) => x)) as WhatsAppApiError;
    expect(e.kind).toBe("server");
    expect(e.retryable).toBe(true);
    expect(e.message).not.toContain("TOKEN-SECRETO");
  });

  it("exige token y phone_number_id", () => {
    expect(() => new WhatsAppClient({ accessToken: "", phoneNumberId: PNID })).toThrow();
    expect(() => new WhatsAppClient({ accessToken: "t", phoneNumberId: "" })).toThrow();
  });
});

describe("ventana de 24 horas", () => {
  const now = new Date("2027-03-02T12:00:00Z");
  it("abierta si el cliente escribio hace menos de 24 h", () => {
    expect(isWithinServiceWindow(new Date("2027-03-01T12:00:01Z"), now)).toBe(true);
    expect(isWithinServiceWindow(new Date("2027-03-02T11:59:00Z"), now)).toBe(true);
  });
  it("cerrada a las 24 h exactas, despues, o sin mensajes del cliente", () => {
    expect(isWithinServiceWindow(new Date("2027-03-01T12:00:00Z"), now)).toBe(false);
    expect(isWithinServiceWindow(new Date("2027-02-27T12:00:00Z"), now)).toBe(false);
    expect(isWithinServiceWindow(null, now)).toBe(false);
  });
  it("calcula cuando se cierra", () => {
    expect(windowClosesAt(new Date("2027-03-01T12:00:00Z"))?.toISOString()).toBe("2027-03-02T12:00:00.000Z");
    expect(windowClosesAt(null)).toBeNull();
  });
});

describe("credenciales del canal", () => {
  const key = randomBytes(32);
  it("se cifran y descifran", () => {
    const blob = sealChannelCredentials({ accessToken: "EAAG-token" }, key, "t1", "c1");
    expect(blob.toString("utf8")).not.toContain("EAAG-token");
    expect(openChannelCredentials(blob, key, "t1", "c1")).toEqual({ accessToken: "EAAG-token" });
  });
  it("un token copiado a otro canal o negocio no se puede abrir", () => {
    const blob = sealChannelCredentials({ accessToken: "x" }, key, "t1", "c1");
    expect(() => openChannelCredentials(blob, key, "t1", "c2")).toThrow(/No se pudo descifrar/);
    expect(() => openChannelCredentials(blob, key, "t2", "c1")).toThrow(/No se pudo descifrar/);
  });
});
