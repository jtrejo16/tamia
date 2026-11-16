import { randomUUID } from "node:crypto";
import {
  agentConfigs,
  businessHours,
  channels,
  contacts,
  conversations,
  createDb,
  knowledgeDocs,
  services,
  staff,
  staffServices,
  tenants,
  type DbHandle,
} from "@empleado/db";
import {
  LLMError,
  type ChatRequest,
  type ChatResponse,
  type LLMProvider,
} from "@empleado/llm";
import { eq } from "drizzle-orm";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta ${name}`);
  return v;
}

try {
  process.loadEnvFile("../../.env");
} catch {
  /* CI */
}

export const NOW = new Date("2027-03-01T18:00:00Z"); // lunes 1-mar-2027, 12:00 en Merida (UTC-6)
export const TUESDAY_10 = "2027-03-02T16:00:00.000Z"; // martes 10:00 hora de Merida

export type Step =
  | { text: string; cost?: number }
  | { tools: Array<{ name: string; args: Record<string, unknown> | string }>; cost?: number }
  | { error: Error };

/** Modelo falso con guion: cada llamada consume el siguiente paso (el ultimo se repite). */
export class FakeLLM implements LLMProvider {
  requests: ChatRequest[] = [];
  private i = 0;
  constructor(private steps: Array<Step | ((req: ChatRequest) => Step)>) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push({ ...req, messages: [...req.messages] });
    const raw = this.steps[Math.min(this.i++, this.steps.length - 1)]!;
    const step = typeof raw === "function" ? raw(req) : raw;
    if ("error" in step) throw step.error;
    const usage = { promptTokens: 1000, completionTokens: 50, costUsd: step.cost ?? 0.0001 };
    if ("tools" in step) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: step.tools.map((t, n) => ({
            id: `call_${this.i}_${n}`,
            type: "function" as const,
            function: {
              name: t.name,
              arguments: typeof t.args === "string" ? t.args : JSON.stringify(t.args),
            },
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

export const failing = (status = 500) =>
  ({ error: new LLMError("el proveedor fallo", { status, retryable: true }) }) satisfies Step;

export interface World {
  tenantId: string;
  conversationId: string;
  contactId: string;
  channelId: string;
  serviceId: string;
  staffId: string;
  /** Crea otro contacto (con su conversacion) en el mismo negocio. */
  otherContactId: string;
}

export interface Handles {
  owner: DbHandle;
  app: DbHandle;
}

export function openDbs(): Handles {
  return {
    owner: createDb(requireEnv("DATABASE_URL"), { max: 2 }),
    app: createDb(requireEnv("DATABASE_APP_URL"), { max: 6 }),
  };
}

/** Un negocio dental completo y aislado para una prueba. */
export async function makeWorld(
  owner: DbHandle,
  options: { autonomy?: "copilot" | "semi" | "auto"; contactName?: string | null; model?: string } = {},
): Promise<World> {
  const { db } = owner;
  const suffix = randomUUID().slice(0, 8);
  const [tenant] = await db
    .insert(tenants)
    .values({
      name: "Clínica Test",
      slug: `test-agent-${suffix}`,
      vertical: "dental",
      timezone: "America/Merida",
      profile: {
        description: "clínica dental de prueba",
        address: "Calle 60 #500, Mérida",
        mapsUrl: "https://maps.example/test",
        latitude: 20.96,
        longitude: -89.62,
        cancellationPolicy: "Avisar con 12 horas de anticipación.",
        cancellationNoticeHours: 12,
      },
      humanHours: {
        mon: ["09:00", "19:00"],
        tue: ["09:00", "19:00"],
        wed: ["09:00", "19:00"],
        thu: ["09:00", "19:00"],
        fri: ["09:00", "19:00"],
        sat: null,
        sun: null,
      },
    })
    .returning();
  const tenantId = tenant!.id;

  await db.insert(agentConfigs).values({
    tenantId,
    assistantName: "Sonri",
    model: options.model ?? "anthropic/claude-haiku-5.5",
    fallbackModel: "anthropic/claude-sonnet-5.5",
    autonomy: options.autonomy ?? "auto",
    packSlug: "dental",
    forbiddenTopics: ["diagnósticos"],
  });

  const [channel] = await db
    .insert(channels)
    .values({ tenantId, type: "whatsapp", externalId: `test-agent-${suffix}` })
    .returning();

  const [service] = await db
    .insert(services)
    .values({ tenantId, name: "Limpieza dental", durationMin: 45, bufferMin: 10, priceCents: 60000 })
    .returning();
  const [member] = await db.insert(staff).values({ tenantId, name: "Dra. Ruiz" }).returning();
  await db.insert(staffServices).values({ tenantId, staffId: member!.id, serviceId: service!.id });
  await db.insert(businessHours).values(
    [1, 2, 3, 4, 5].map((weekday) => ({ tenantId, weekday, opens: "09:00", closes: "19:00" })),
  );

  await db.insert(knowledgeDocs).values({
    tenantId,
    title: "Preguntas frecuentes",
    sourceType: "text",
    status: "ready",
    rawText:
      "¿Aceptan seguros dentales? Trabajamos con reembolso: damos factura y receta; no hay convenio directo.\n" +
      "¿Atienden niños? Sí, a partir de 4 años.",
  });

  const mkContact = async (phone: string, name: string | null) => {
    const [c] = await db
      .insert(contacts)
      .values({ tenantId, phoneE164: phone, displayName: name })
      .returning();
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId, contactId: c!.id, channelId: channel!.id })
      .returning();
    return { contactId: c!.id, conversationId: conv!.id };
  };
  const main = await mkContact(`+52999${suffix.replace(/\D/g, "").padEnd(7, "1").slice(0, 7)}`, options.contactName === undefined ? "Carlos Pérez" : options.contactName);
  const other = await mkContact(`+52998${suffix.replace(/\D/g, "").padEnd(7, "2").slice(0, 7)}`, "Otra Persona");

  return {
    tenantId,
    conversationId: main.conversationId,
    contactId: main.contactId,
    channelId: channel!.id,
    serviceId: service!.id,
    staffId: member!.id,
    otherContactId: other.contactId,
  };
}

export async function dropWorld(owner: DbHandle, world: World): Promise<void> {
  await owner.db.delete(tenants).where(eq(tenants.id, world.tenantId));
}
