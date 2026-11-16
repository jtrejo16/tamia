import { describe, expect, it, vi } from "vitest";
import {
  SOCIAL_TEXT_LIMIT,
  SocialClient,
  WhatsAppApiError,
  classifySocialError,
  createWhatsAppWebhook,
  parseSocialWebhook,
  signBody,
  splitForChannel,
  type InboundJobData,
  type WebhookDeps,
} from "../src";

const PAGE = "104000000000001";
const IGID = "17841400000000002";
const PSID = "5000000000000001";

const messenger = (event: Record<string, unknown>) => ({
  object: "page",
  entry: [{ id: PAGE, time: 1767225600000, messaging: [{ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1767225600000, ...event }] }],
});
const instagram = (event: Record<string, unknown>) => ({
  object: "instagram",
  entry: [{ id: IGID, time: 1767225600000, messaging: [{ sender: { id: PSID }, recipient: { id: IGID }, timestamp: 1767225600000, ...event }] }],
});

describe("parseSocialWebhook", () => {
  it("texto de Messenger: id de la pagina, id del cliente, segundos y texto", () => {
    const r = parseSocialWebhook(messenger({ message: { mid: "m_1", text: "Hola, ¿tienen citas?" } }));
    expect(r.messages).toEqual([
      {
        channelType: "messenger",
        accountId: PAGE,
        senderId: PSID,
        message: { id: "m_1", from: PSID, timestamp: 1767225600, type: "text", text: "Hola, ¿tienen citas?" },
      },
    ]);
  });

  it("texto de Instagram se marca como instagram y usa el id de la cuenta", () => {
    const r = parseSocialWebhook(instagram({ message: { mid: "ig_1", text: "Precio de limpieza?" } }));
    expect(r.messages[0]).toMatchObject({ channelType: "instagram", accountId: IGID, senderId: PSID });
  });

  it("IGNORA los ecos (mensajes que envio la propia pagina), lecturas y entregas", () => {
    expect(parseSocialWebhook(messenger({ message: { mid: "m_2", text: "respuesta nuestra", is_echo: true } })).messages).toHaveLength(0);
    const read = parseSocialWebhook(messenger({ read: { watermark: 1 } }));
    expect(read).toEqual({ messages: [], ignored: 1 });
    expect(parseSocialWebhook(messenger({ delivery: { mids: ["m_1"] } })).messages).toHaveLength(0);
  });

  it("imagen, audio y archivo conservan el enlace; la ubicacion trae coordenadas", () => {
    const img = parseSocialWebhook(messenger({ message: { mid: "a", attachments: [{ type: "image", payload: { url: "https://cdn/x.jpg" } }] } })).messages[0]!.message;
    expect(img).toMatchObject({ type: "image", mediaUrl: "https://cdn/x.jpg" });
    expect(parseSocialWebhook(messenger({ message: { mid: "b", attachments: [{ type: "audio", payload: { url: "https://cdn/a.mp4" } }] } })).messages[0]!.message.type).toBe("audio");
    expect(parseSocialWebhook(messenger({ message: { mid: "c", attachments: [{ type: "file", payload: { url: "https://cdn/f.pdf" } }] } })).messages[0]!.message.type).toBe("document");
    const loc = parseSocialWebhook(messenger({ message: { mid: "d", attachments: [{ type: "location", payload: { coordinates: { lat: 20.96, long: -89.62 } } }] } })).messages[0]!.message;
    expect(loc).toMatchObject({ type: "location", location: { latitude: 20.96, longitude: -89.62 } });
  });

  it("un adjunto no soportado (story, reel, video...) llega como texto explicativo, no se pierde en silencio", () => {
    const m = parseSocialWebhook(instagram({ message: { mid: "e", attachments: [{ type: "story_mention", payload: { url: "https://cdn/s" } }] } })).messages[0]!.message;
    expect(m.type).toBe("text");
    expect(m.text).toContain("story_mention");
    // si ademas escribio algo, se conserva su texto
    expect(parseSocialWebhook(instagram({ message: { mid: "f", text: "mira", attachments: [{ type: "video", payload: {} }] } })).messages[0]!.message.text).toBe("mira");
  });

  it("botones: respuesta rapida y postback llegan como 'interactive' con su payload", () => {
    const quick = parseSocialWebhook(messenger({ message: { mid: "g", text: "Sí", quick_reply: { payload: "CONFIRMAR" } } })).messages[0]!.message;
    expect(quick).toMatchObject({ type: "interactive", replyPayload: "CONFIRMAR", text: "Sí" });
    const post = parseSocialWebhook(messenger({ postback: { mid: "h", title: "Empezar", payload: "START" } })).messages[0]!.message;
    expect(post).toMatchObject({ id: "h", type: "interactive", replyPayload: "START", text: "Empezar" });
  });

  it("basura, otros objetos y mensajes vacios no producen nada ni lanzan", () => {
    expect(parseSocialWebhook(null).messages).toEqual([]);
    expect(parseSocialWebhook({ object: "whatsapp_business_account", entry: [] }).messages).toEqual([]);
    expect(parseSocialWebhook({ object: "page", entry: [{ id: PAGE, messaging: "no" }] }).messages).toEqual([]);
    expect(parseSocialWebhook(messenger({ message: { mid: "z", text: "   " } })).messages).toEqual([]);
    expect(parseSocialWebhook(messenger({ sender: {}, message: { mid: "y", text: "x" } })).messages).toEqual([]);
  });
});

describe("splitForChannel", () => {
  it("un texto corto no se parte; uno largo se parte respetando el limite y sin perder contenido", () => {
    expect(splitForChannel("hola", 1000)).toEqual(["hola"]);
    const para = "Esta es una oracion de ejemplo bastante larga para llenar espacio. ";
    const text = para.repeat(40).trim();
    const parts = splitForChannel(text, SOCIAL_TEXT_LIMIT.instagram);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= SOCIAL_TEXT_LIMIT.instagram && p.length > 0)).toBe(true);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("corta sin espacios (una sola palabra enorme) sin entrar en ciclo", () => {
    const parts = splitForChannel("x".repeat(2500), 1000);
    expect(parts.map((p) => p.length)).toEqual([1000, 1000, 500]);
  });
});

describe("classifySocialError", () => {
  it("clasifica los errores de Meta que importan", () => {
    expect(classifySocialError(400, 190, undefined)).toBe("auth");
    expect(classifySocialError(401, undefined, undefined)).toBe("auth");
    expect(classifySocialError(400, 10, 2018278)).toBe("window");
    expect(classifySocialError(400, 551, undefined)).toBe("window");
    expect(classifySocialError(400, 4, undefined)).toBe("rate");
    expect(classifySocialError(429, undefined, undefined)).toBe("rate");
    expect(classifySocialError(500, 2, undefined)).toBe("server");
    expect(classifySocialError(400, 100, undefined)).toBe("other");
  });
});

describe("SocialClient", () => {
  const make = (channelType: "messenger" | "instagram", responder: (body: any) => { status?: number; json: unknown }) => {
    const calls: Array<{ url: string; auth: string | null; body: any }> = [];
    const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body });
      const r = responder(body);
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
    }) as typeof fetch;
    return { client: new SocialClient({ accessToken: "PAGE-TOKEN", accountId: channelType === "messenger" ? PAGE : IGID, channelType, fetch: fetchFake }), calls };
  };
  let n = 0;
  const ok = () => ({ json: { recipient_id: PSID, message_id: `mid.${++n}` } });

  it("envia a /{cuenta}/messages con la clave de la pagina y devuelve el id de Meta", async () => {
    const { client, calls } = make("messenger", ok);
    const r = await client.sendText(PSID, "Hola");
    expect(r.wamid).toMatch(/^mid\./);
    expect(calls[0]!.url).toBe(`https://graph.facebook.com/v23.0/${PAGE}/messages`);
    expect(calls[0]!.auth).toBe("Bearer PAGE-TOKEN");
    expect(calls[0]!.body).toEqual({ recipient: { id: PSID }, messaging_type: "RESPONSE", message: { text: "Hola" } });
  });

  it("un texto mas largo que el limite de Instagram se manda en varios mensajes y devuelve el ultimo id", async () => {
    const { client, calls } = make("instagram", ok);
    const text = "Una frase corta y clara. ".repeat(120).trim(); // ~3000 caracteres
    const r = await client.sendText(PSID, text);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every((c) => c.body.message.text.length <= 1000)).toBe(true);
    expect(r.wamid).toBe(`mid.${n}`);
  });

  it("la ubicacion se manda como texto con el enlace del mapa (estas redes no tienen mensaje de ubicacion)", async () => {
    const { client, calls } = make("messenger", ok);
    await client.sendLocation(PSID, { latitude: 20.9, longitude: -89.6, name: "Clínica", address: "Calle 60" });
    expect(calls[0]!.body.message.text).toBe("Clínica\nCalle 60\nhttps://maps.google.com/?q=20.9,-89.6");
  });

  it("las plantillas no existen fuera de WhatsApp", async () => {
    const { client } = make("messenger", ok);
    await expect(client.sendTemplate()).rejects.toMatchObject({ kind: "other" });
  });

  it("errores de Meta: fuera de ventana, clave vencida y falla del servidor se clasifican (y solo el ultimo se reintenta)", async () => {
    const err = (status: number, code: number, subcode?: number) => () => ({ status, json: { error: { message: "x", code, error_subcode: subcode } } });
    const window = await make("messenger", err(400, 10, 2018278)).client.sendText(PSID, "a").catch((e) => e);
    expect(window).toBeInstanceOf(WhatsAppApiError);
    expect(window).toMatchObject({ kind: "window", retryable: false });
    const auth = await make("messenger", err(400, 190)).client.sendText(PSID, "a").catch((e) => e);
    expect(auth).toMatchObject({ kind: "auth", retryable: false });
    const server = await make("instagram", err(500, 2)).client.sendText(PSID, "a").catch((e) => e);
    expect(server).toMatchObject({ kind: "server", retryable: true });
  });
});

describe("el webhook atiende Messenger e Instagram", () => {
  const SECRET = "secreto-de-prueba";
  function setup(known: Record<string, { tenantId: string; channelId: string }>) {
    const inbound: InboundJobData[] = [];
    const deps: WebhookDeps = {
      verifyToken: "v",
      appSecret: SECRET,
      resolveChannel: async () => null,
      resolveSocialChannel: async (type, id) => known[`${type}:${id}`] ?? null,
      enqueueInbound: async (j) => void inbound.push(j),
      enqueueStatus: async () => {},
      log: vi.fn(),
    };
    const post = (obj: unknown, sig?: string) => {
      const raw = JSON.stringify(obj);
      return createWhatsAppWebhook(deps).POST(
        new Request("https://x/webhooks/whatsapp", { method: "POST", headers: { "x-hub-signature-256": sig ?? signBody(raw, SECRET) }, body: raw }),
      );
    };
    return { inbound, post };
  }

  it("encola el mensaje con su tipo de canal y el id de la cuenta; mensajes de cuentas desconocidas se descartan", async () => {
    const { inbound, post } = setup({ [`messenger:${PAGE}`]: { tenantId: "t1", channelId: "c1" } });
    expect((await post(messenger({ message: { mid: "m_1", text: "Hola" } }))).status).toBe(200);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({ tenantId: "t1", channelId: "c1", channelType: "messenger", phoneNumberId: PAGE, message: { from: PSID, text: "Hola" } });

    expect((await post(instagram({ message: { mid: "i_1", text: "x" } }))).status).toBe(200); // cuenta de IG sin canal
    expect(inbound).toHaveLength(1);
  });

  it("sin firma valida NO se encola nada (401)", async () => {
    const { inbound, post } = setup({ [`messenger:${PAGE}`]: { tenantId: "t1", channelId: "c1" } });
    const res = await post(messenger({ message: { mid: "m_9", text: "falso" } }), "sha256=" + "0".repeat(64));
    expect(res.status).toBe(401);
    expect(inbound).toHaveLength(0);
  });

  it("un error al encolar devuelve 500 para que Meta reintente", async () => {
    const deps: WebhookDeps = {
      verifyToken: "v",
      appSecret: SECRET,
      resolveChannel: async () => null,
      resolveSocialChannel: async () => ({ tenantId: "t", channelId: "c" }),
      enqueueInbound: async () => {
        throw new Error("redis caido");
      },
      enqueueStatus: async () => {},
    };
    const raw = JSON.stringify(messenger({ message: { mid: "m_5", text: "hola" } }));
    const res = await createWhatsAppWebhook(deps).POST(new Request("https://x", { method: "POST", headers: { "x-hub-signature-256": signBody(raw, SECRET) }, body: raw }));
    expect(res.status).toBe(500);
  });
});
