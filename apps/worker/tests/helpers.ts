import { randomBytes, randomUUID } from "node:crypto";
import { sealChannelCredentials } from "@empleado/channels";
import {
  agentConfigs,
  channels,
  contacts,
  conversations,
  createDb,
  messages,
  tenants,
  type DbHandle,
} from "@empleado/db";
import type { ChatRequest, ChatResponse, LLMProvider } from "@empleado/llm";
import { eq } from "drizzle-orm";
import type { Sender } from "../src/processors/outbound";

try {
  process.loadEnvFile("../../.env");
} catch {
  /* CI */
}

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta ${name}`);
  return v;
}

export interface Dbs {
  owner: DbHandle;
  app: DbHandle;
}
export const openDbs = (): Dbs => ({
  owner: createDb(env("DATABASE_URL"), { max: 2 }),
  app: createDb(env("DATABASE_APP_URL"), { max: 8 }),
});

export const KEY = randomBytes(32);
export const NOW = new Date("2027-03-01T18:00:00Z");

export type Step = { text: string } | { tools: Array<{ name: string; args: Record<string, unknown> }> };

/** Modelo falso con guion; el ultimo paso se repite. `delayMs` simula latencia. */
export class FakeLLM implements LLMProvider {
  requests: ChatRequest[] = [];
  private i = 0;
  constructor(
    private steps: Step[] = [{ text: "Respuesta de prueba" }],
    private delayMs = 0,
  ) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push({ ...req, messages: [...req.messages] });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const step = this.steps[Math.min(this.i++, this.steps.length - 1)]!;
    const usage = { promptTokens: 100, completionTokens: 10, costUsd: 0 };
    if ("tools" in step) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: step.tools.map((t, n) => ({
            id: `call_${this.i}_${n}`,
            type: "function" as const,
            function: { name: t.name, arguments: JSON.stringify(t.args) },
          })),
        },
        usage,
        model: req.model,
        usedFallback: false,
        finishReason: "tool_calls",
      };
    }
    return {
      message: { role: "assistant", content: step.text },
      usage,
      model: req.model,
      usedFallback: false,
      finishReason: "stop",
    };
  }
}

export interface SentCall {
  kind: "text" | "location";
  to: string;
  body?: string;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
}

export class FakeSender implements Sender {
  calls: SentCall[] = [];
  private n = 0;
  /** Se ejecuta antes de cada envio; puede lanzar para simular fallos. */
  beforeSend: () => void = () => {};
  async sendText(to: string, body: string) {
    this.beforeSend();
    this.calls.push({ kind: "text", to, body });
    return { wamid: `wamid.OUT${++this.n}-${randomUUID().slice(0, 6)}` };
  }
  async sendLocation(to: string, location: SentCall["location"] & object) {
    this.beforeSend();
    this.calls.push({ kind: "location", to, location });
    return { wamid: `wamid.OUT${++this.n}-${randomUUID().slice(0, 6)}` };
  }
}

export interface World {
  tenantId: string;
  channelId: string;
  /** phone_number_id del canal (unico por prueba). */
  phoneNumberId: string;
  conversationId: string;
  contactId: string;
  phone: string; // E.164 con +
  waId: string; // solo digitos
}

/** Un negocio con canal conectado (token cifrado) y un cliente con conversacion abierta. */
export async function makeWorld(
  owner: DbHandle,
  options: { withCredentials?: boolean; lastInboundAt?: Date | null; autonomy?: "auto" | "copilot" } = {},
): Promise<World> {
  const { db } = owner;
  const suffix = randomUUID().slice(0, 8);
  const [tenant] = await db
    .insert(tenants)
    .values({
      name: "Clínica Worker",
      slug: `test-worker-${suffix}`,
      vertical: "dental",
      timezone: "America/Merida",
      profile: {
        description: "clínica de prueba",
        address: "Calle 60 #500",
        mapsUrl: "https://maps.example/x",
        latitude: 20.96,
        longitude: -89.62,
      },
    })
    .returning();
  const tenantId = tenant!.id;
  await db.insert(agentConfigs).values({
    tenantId,
    model: "anthropic/claude-haiku-5.5",
    autonomy: options.autonomy ?? "auto",
    packSlug: "dental",
  });

  const phoneNumberId = `test-pn-${suffix}`;
  const [channel] = await db
    .insert(channels)
    .values({ tenantId, type: "whatsapp", externalId: phoneNumberId })
    .returning();
  if (options.withCredentials !== false) {
    await db
      .update(channels)
      .set({ credentialsEnc: sealChannelCredentials({ accessToken: "EAAG-token-de-prueba" }, KEY, tenantId, channel!.id) })
      .where(eq(channels.id, channel!.id));
  }

  const digits = `52198${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
  const [contact] = await db
    .insert(contacts)
    .values({ tenantId, phoneE164: `+${digits}`, displayName: "Carlos Pérez" })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({
      tenantId,
      contactId: contact!.id,
      channelId: channel!.id,
      lastInboundAt: options.lastInboundAt === undefined ? NOW : options.lastInboundAt,
    })
    .returning();

  return {
    tenantId,
    channelId: channel!.id,
    phoneNumberId,
    conversationId: conversation!.id,
    contactId: contact!.id,
    phone: `+${digits}`,
    waId: digits,
  };
}

export async function dropWorld(owner: DbHandle, w: World): Promise<void> {
  await owner.db.delete(tenants).where(eq(tenants.id, w.tenantId));
}

/** Deja un mensaje saliente en cola, como lo haria el agente. */
export async function queueMessage(
  owner: DbHandle,
  w: World,
  m: { type?: "text" | "location" | "template"; body: string; createdAt?: Date },
) {
  const [row] = await owner.db
    .insert(messages)
    .values({
      tenantId: w.tenantId,
      conversationId: w.conversationId,
      channelId: w.channelId,
      direction: "out",
      sender: "bot",
      type: m.type ?? "text",
      body: m.body,
      status: "queued",
      ...(m.createdAt ? { createdAt: m.createdAt } : {}),
    })
    .returning();
  return row!;
}

export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  { timeoutMs = 20_000, intervalMs = 100, what = "condicion" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Se agoto el tiempo esperando: ${what}`);
}
