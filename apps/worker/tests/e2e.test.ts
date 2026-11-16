import { randomUUID } from "node:crypto";
import { createWhatsAppWebhook, signBody, type WebhookHandlers } from "@empleado/channels";
import { messages, resolveChannel } from "@empleado/db";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisLock } from "../src/lock";
import { createInboundProcessor } from "../src/processors/inbound";
import { createOutboundProcessor } from "../src/processors/outbound";
import { createStatusProcessor } from "../src/processors/status";
import { createConnection, createEnqueuers, createQueues, type Queues } from "../src/queues";
import { RedisRateLimiter } from "../src/ratelimit";
import { startWorkers, type RunningWorkers } from "../src/workers";
import {
  FakeLLM,
  FakeSender,
  KEY,
  dropWorld,
  env,
  makeWorld,
  openDbs,
  waitFor,
  type Dbs,
  type World,
} from "./helpers";

const APP_SECRET = "secreto-de-pruebas-e2e";
const VERIFY = "verify-e2e";

let dbs: Dbs;
let w: World;
let prefix: string;
let redis: ReturnType<typeof createConnection>;
let queues: Queues;
let workers: RunningWorkers;
let hooks: WebhookHandlers;
let llm: FakeLLM;
let sender: FakeSender;

beforeAll(async () => {
  dbs = openDbs();
  w = await makeWorld(dbs.owner, { lastInboundAt: null });
  prefix = `test-${randomUUID().slice(0, 8)}`;
  redis = createConnection(env("REDIS_URL"));
  queues = createQueues(redis, prefix);
  const enqueue = createEnqueuers(queues);

  // 150 ms de latencia en el modelo: asi dos mensajes simultaneos realmente se traslapan.
  llm = new FakeLLM([{ text: "Respuesta 1" }, { text: "Respuesta 2" }, { text: "Respuesta 3" }], 150);
  sender = new FakeSender();
  const lock = new RedisLock(redis, prefix);

  workers = startWorkers({
    connection: redis,
    prefix,
    handlers: {
      inbound: createInboundProcessor({
        db: dbs.app.db,
        llm,
        enqueueOutbound: enqueue.outbound,
        lock,
        limiter: new RedisRateLimiter(redis, prefix),
      }),
      outbound: createOutboundProcessor({ db: dbs.app.db, key: KEY, makeSender: () => sender, lock }),
      status: createStatusProcessor({ db: dbs.app.db }),
    },
  });

  hooks = createWhatsAppWebhook({
    verifyToken: VERIFY,
    appSecret: APP_SECRET,
    resolveChannel: (id) => resolveChannel(dbs.app.db, "whatsapp", id),
    enqueueInbound: enqueue.inbound,
    enqueueStatus: enqueue.status,
  });
});

afterAll(async () => {
  await workers?.close();
  for (const q of [queues?.inbound, queues?.outbound, queues?.status]) await q?.obliterate({ force: true }).catch(() => {});
  await queues?.close();
  redis?.disconnect();
  if (w) await dropWorld(dbs.owner, w);
  await dbs?.app.close();
  await dbs?.owner.close();
});

const payload = (value: Record<string, unknown>) =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: { messaging_product: "whatsapp", metadata: { phone_number_id: w.phoneNumberId, display_phone_number: "0" }, ...value },
          },
        ],
      },
    ],
  });

const post = (body: string, secret = APP_SECRET) =>
  hooks.POST(
    new Request("https://x.test/webhooks/whatsapp", {
      method: "POST",
      headers: { "x-hub-signature-256": signBody(body, secret) },
      body,
    }),
  );

const customerMessage = (id: string, text: string) =>
  payload({
    contacts: [{ profile: { name: "Ana" }, wa_id: w.waId }],
    messages: [{ from: w.waId, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
  });

const outbound = () =>
  dbs.owner.db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, w.conversationId), eq(messages.direction, "out")))
    .orderBy(asc(messages.createdAt));

describe("de punta a punta con Redis real", () => {
  it("un mensaje firmado recorre webhook -> cola -> agente -> cola -> envio -> avisos de entrega", async () => {
    const res = await post(customerMessage("wamid.E2E1", "Hola, quiero informes"));
    expect(res.status).toBe(200);

    // El cliente recibe la respuesta del agente por la "API de WhatsApp".
    await waitFor(() => sender.calls.length >= 1, { what: "el envio de la respuesta" });
    expect(sender.calls[0]).toEqual({ kind: "text", to: w.waId, body: "Respuesta 1" });

    const [sent] = await waitFor(async () => {
      const rows = await outbound();
      return rows[0]?.status === "sent" ? rows : null;
    }, { what: "estado 'sent' en la base de datos" });
    expect(sent!.externalId).toMatch(/^wamid\.OUT/);

    // Meta avisa que se entrego y se leyo.
    for (const status of ["delivered", "read"] as const) {
      const r = await post(payload({ statuses: [{ id: sent!.externalId, status, timestamp: "1767225600", recipient_id: w.waId }] }));
      expect(r.status).toBe(200);
    }
    await waitFor(async () => (await outbound())[0]?.status === "read", { what: "estado 'read'" });
  });

  it("firma falsa -> 401 y no se procesa nada", async () => {
    const before = sender.calls.length;
    const res = await post(customerMessage("wamid.FALSO", "intruso"), "otro-secreto");
    expect(res.status).toBe(401);
    await new Promise((r) => setTimeout(r, 400));
    expect(sender.calls.length).toBe(before);
  });

  it("el mismo webhook entregado dos veces (reintento de Meta) genera UNA sola respuesta", async () => {
    const before = sender.calls.length;
    const body = customerMessage("wamid.DUP", "¿Cuál es el horario?");
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200);
    await waitFor(() => sender.calls.length > before, { what: "la respuesta" });
    await new Promise((r) => setTimeout(r, 800)); // margen para detectar un envio duplicado
    expect(sender.calls.length).toBe(before + 1);
  });

  it("dos mensajes casi simultaneos del mismo cliente se atienden EN ORDEN (el segundo ve la primera respuesta)", async () => {
    const before = sender.calls.length;
    const startedAt = llm.requests.length;
    await Promise.all([
      post(customerMessage("wamid.RAFAGA1", "Primero: hola")),
      post(customerMessage("wamid.RAFAGA2", "Segundo: ¿y la ubicación?")),
    ]);
    await waitFor(() => sender.calls.length >= before + 2, { what: "las dos respuestas" });

    const requests = llm.requests.slice(startedAt);
    expect(requests).toHaveLength(2);
    const visibleInSecond = JSON.stringify(requests[1]!.messages);
    // La segunda consulta al modelo ya incluye el mensaje y la respuesta de la primera.
    expect(visibleInSecond).toContain("Primero: hola");
    expect(visibleInSecond).toMatch(/Respuesta \d/);
    expect(visibleInSecond).toContain("Segundo: ¿y la ubicación?");
  });

  it("un numero que no esta registrado se ignora con 200", async () => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "x", changes: [{ field: "messages", value: { metadata: { phone_number_id: "numero-desconocido" }, messages: [{ from: "1", id: "wamid.X", type: "text", text: { body: "hola" } }] } }] }],
    });
    const before = sender.calls.length;
    expect((await post(body)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 400));
    expect(sender.calls.length).toBe(before);
  });
});
