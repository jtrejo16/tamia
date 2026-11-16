import { randomUUID } from "node:crypto";
import {
  agentConfigs,
  approvals,
  businessHours,
  channels,
  contacts,
  conversations,
  createDb,
  memberships,
  messages,
  services,
  staff,
  staffServices,
  tenants,
  users,
  type DbHandle,
  type ProposedAction,
} from "@empleado/db";
import type { ChatRequest, ChatResponse, LLMProvider } from "@empleado/llm";
import { hashPassword } from "@empleado/shared";
import { eq } from "drizzle-orm";
import type { PanelContext } from "../src";

try {
  process.loadEnvFile("../../.env");
} catch {
  /* CI */
}

export const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Falta ${name}`);
  return v;
};

export interface Dbs {
  owner: DbHandle;
  app: DbHandle;
}
export const openDbs = (): Dbs => ({
  owner: createDb(env("DATABASE_URL"), { max: 2 }),
  app: createDb(env("DATABASE_APP_URL"), { max: 8 }),
});

/** lunes 1-mar-2027 12:00 en Merida */
export const NOW = new Date("2027-03-01T18:00:00Z");
/** martes 2-mar-2027 10:00 en Merida */
export const TUESDAY_10 = "2027-03-02T16:00:00.000Z";
export const PASSWORD = "Contraseña-de-prueba-2027";

export interface World {
  tenantId: string;
  channelId: string;
  conversationId: string;
  contactId: string;
  serviceId: string;
  staffId: string;
  ownerEmail: string;
  ownerId: string;
  agentId: string;
  viewerId: string;
  owner: PanelContext;
  agent: PanelContext;
  viewer: PanelContext;
}

export async function makeWorld(
  owner: DbHandle,
  options: { autonomy?: "auto" | "copilot" | "semi"; lastInboundAt?: Date | null; withPassword?: boolean } = {},
): Promise<World> {
  const { db } = owner;
  const suffix = randomUUID().slice(0, 8);
  const [tenant] = await db
    .insert(tenants)
    .values({
      name: "Clínica Panel",
      slug: `test-panel-${suffix}`,
      vertical: "dental",
      timezone: "America/Merida",
      profile: { cancellationNoticeHours: 12 },
    })
    .returning();
  const tenantId = tenant!.id;
  await db.insert(agentConfigs).values({
    tenantId,
    model: "anthropic/claude-haiku-5.5",
    autonomy: options.autonomy ?? "auto",
    packSlug: "dental",
  });

  const [channel] = await db
    .insert(channels)
    .values({ tenantId, type: "whatsapp", externalId: `test-panel-${suffix}` })
    .returning();

  const hash = options.withPassword === false ? null : await hashPassword(PASSWORD);
  const mkUser = async (label: string, role: "owner" | "agent" | "viewer") => {
    const [u] = await db
      .insert(users)
      .values({ email: `${label}-${suffix}@test.local`, name: `${label} de prueba`, passwordHash: hash })
      .returning();
    await db.insert(memberships).values({ tenantId, userId: u!.id, role });
    return u!;
  };
  const o = await mkUser("dueno", "owner");
  const a = await mkUser("recepcion", "agent");
  const v = await mkUser("lector", "viewer");

  const [service] = await db
    .insert(services)
    .values({ tenantId, name: "Limpieza dental", durationMin: 45, bufferMin: 10, priceCents: 60000 })
    .returning();
  const [member] = await db.insert(staff).values({ tenantId, name: "Dra. Ruiz" }).returning();
  await db.insert(staffServices).values({ tenantId, staffId: member!.id, serviceId: service!.id });
  await db.insert(businessHours).values(
    [1, 2, 3, 4, 5].map((weekday) => ({ tenantId, weekday, opens: "09:00", closes: "19:00" })),
  );

  const [contact] = await db
    .insert(contacts)
    .values({
      tenantId,
      phoneE164: `+52198${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      displayName: "Carlos Pérez",
      profile: { whatsapp_name: "Carlitos" },
    })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({
      tenantId,
      contactId: contact!.id,
      channelId: channel!.id,
      lastInboundAt: options.lastInboundAt === undefined ? NOW : options.lastInboundAt,
      lastMessageAt: NOW,
    })
    .returning();

  const ctx = (userId: string, role: PanelContext["role"]): PanelContext => ({ tenantId, userId, role });
  return {
    tenantId,
    channelId: channel!.id,
    conversationId: conversation!.id,
    contactId: contact!.id,
    serviceId: service!.id,
    staffId: member!.id,
    ownerEmail: o.email,
    ownerId: o.id,
    agentId: a.id,
    viewerId: v.id,
    owner: ctx(o.id, "owner"),
    agent: ctx(a.id, "agent"),
    viewer: ctx(v.id, "viewer"),
  };
}

export async function dropWorld(owner: DbHandle, w: World): Promise<void> {
  await owner.db.delete(tenants).where(eq(tenants.id, w.tenantId));
  for (const id of [w.ownerId, w.agentId, w.viewerId]) await owner.db.delete(users).where(eq(users.id, id));
}

export async function addMessage(
  owner: DbHandle,
  w: World,
  m: {
    conversationId?: string;
    direction: "in" | "out";
    body: string;
    type?: "text" | "location" | "audio";
    transcript?: string;
    createdAt?: Date;
    sender?: "contact" | "bot" | "human";
  },
) {
  const [row] = await owner.db
    .insert(messages)
    .values({
      tenantId: w.tenantId,
      conversationId: m.conversationId ?? w.conversationId,
      channelId: w.channelId,
      direction: m.direction,
      sender: m.sender ?? (m.direction === "in" ? "contact" : "bot"),
      type: m.type ?? "text",
      body: m.body,
      transcript: m.transcript ?? null,
      status: m.direction === "in" ? "received" : "sent",
      ...(m.createdAt ? { createdAt: m.createdAt } : {}),
    })
    .returning();
  return row!;
}

export async function addApproval(
  owner: DbHandle,
  w: World,
  draft: string,
  actions: ProposedAction[] = [],
  conversationId = w.conversationId,
) {
  const [row] = await owner.db
    .insert(approvals)
    .values({ tenantId: w.tenantId, conversationId, draft, proposedActions: actions })
    .returning();
  return row!;
}

export const bookingAction = (w: World, startIso = TUESDAY_10): ProposedAction => ({
  tool: "crear_cita",
  args: { servicio_id: w.serviceId, empleado_id: w.staffId, inicio_iso: startIso },
  summary: "Cita de Limpieza dental con Dra. Ruiz, martes 2 de marzo, 10:00",
});

/** Modelo falso: responde siempre el mismo texto (o el guion que se le pase). */
export class FakeLLM implements LLMProvider {
  requests: ChatRequest[] = [];
  constructor(private texts: string[] = ["Respuesta de prueba"]) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push({ ...req, messages: [...req.messages] });
    const text = this.texts[Math.min(this.requests.length - 1, this.texts.length - 1)]!;
    return {
      message: { role: "assistant", content: text },
      usage: { promptTokens: 10, completionTokens: 5, costUsd: 0 },
      model: req.model,
      usedFallback: false,
      finishReason: "stop",
    };
  }
}
