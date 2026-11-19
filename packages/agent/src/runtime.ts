import {
  agentConfigs,
  approvals,
  channels,
  contacts,
  conversationMemory,
  conversations,
  handoffs,
  messages,
  tenants,
  usageEvents,
  withTenant,
  type Database,
  type Message,
  type ProposedAction,
  type Tx,
} from "@empleado/db";
import {
  assertApprovedModel,
  dataCollectionFor,
  LLMError,
  type ChatMessage,
  type LLMProvider,
} from "@empleado/llm";
import { and, count, desc, eq, gt, gte, isNull } from "drizzle-orm";
import { formatLocal, toPlainText, toWhatsAppText } from "./format";
import { claimsHandoff } from "./handoff-claim";
import { MAX_RAW_HISTORY, maybeSummarize, messageText } from "./memory";
import { GENERIC_PACK, loadPack, type Pack } from "./pack";
import { decideOutput, modeFor, type Autonomy } from "./policy";
import { buildSystemPrompt } from "./prompt";
import { recordEscalation, runTool, toolDefinitions, upcomingAppointments, type ToolRun } from "./tools";
import type { Attachment, TaskState, TurnContext } from "./types";

const MAX_REPLY_CHARS = 3800;
const TECHNICAL_ERROR_REPLY =
  "Tuvimos un problema técnico. Le paso tu mensaje a la recepción para que te contesten lo antes posible.";

export interface RunTurnInput {
  /** Conexion del rol de la APLICACION (sin superusuario), para que RLS se aplique. */
  db: Database;
  llm: LLMProvider;
  tenantId: string;
  conversationId: string;
  text: string;
  type?: Message["type"];
  transcript?: string;
  mediaUrl?: string;
  /** wamid de Meta: evita procesar dos veces el mismo mensaje. */
  externalMessageId?: string;
  now?: Date;
  maxIterations?: number;
  /** El mensaje se guarda pero el asistente no responde (negocio sin acceso: pendiente, sin suscripcion...). */
  agentDisabledReason?: string;
}

export interface TurnUsage {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  models: string[];
  usedFallback: boolean;
}

export interface TurnResult {
  /** send = mensaje en cola de envio; draft = borrador para aprobar; none = el bot no responde. */
  action: "send" | "draft" | "none";
  reason?: "duplicate" | "human_has_control" | "agent_disabled";
  text: string | null;
  approvalId?: string;
  messageId?: string;
  proposedActions: ProposedAction[];
  attachments: Attachment[];
  escalated: boolean;
  /** Si el turno fallo (modelo caido, etc.) y se escalo a una persona. */
  failure?: string;
  toolTrace: ToolRun[];
  usage: TurnUsage;
}

const emptyUsage = (): TurnUsage => ({
  calls: 0,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  models: [],
  usedFallback: false,
});

const nothing = (reason: TurnResult["reason"]): TurnResult => ({
  action: "none",
  reason,
  text: null,
  proposedActions: [],
  attachments: [],
  escalated: false,
  toolTrace: [],
  usage: emptyUsage(),
});

function resolvePack(slug: string | null): Pack {
  if (!slug) return GENERIC_PACK;
  try {
    return loadPack(slug);
  } catch (e) {
    console.warn(`[agent] ${e instanceof Error ? e.message : e}; se usa el pack generico`);
    return GENERIC_PACK;
  }
}

/** Junta mensajes seguidos del mismo rol: algunos proveedores rechazan roles repetidos. */
function toChatHistory(history: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of history) {
    const content = messageText(m);
    if (!content) continue;
    const role = m.direction === "in" ? "user" : "assistant";
    const last = out[out.length - 1];
    if (last && last.role === role && typeof last.content === "string") {
      last.content += `\n${content}`;
    } else {
      out.push({ role, content });
    }
  }
  return out;
}

/** Segundos que se espera antes de considerar que un mensaje guardado sin respuesta quedo "colgado" (y no esta en proceso en otro trabajo). */
const STUCK_AFTER_MS = 90_000;

/**
 * ¿El mensaje entrante ya estaba guardado pero NADIE respondio (ni respuesta, ni borrador, ni escalacion)?
 * Pasa cuando el servicio se detuvo a mitad del turno. Si esta reciente se deja en paz: otro trabajo lo esta procesando.
 */
async function isUnansweredRetry(tx: Tx, channelId: string, conversationId: string, externalId: string): Promise<boolean> {
  const [existing] = await tx
    .select({ createdAt: messages.createdAt, direction: messages.direction })
    .from(messages)
    .where(and(eq(messages.channelId, channelId), eq(messages.externalId, externalId)));
  if (!existing || existing.direction !== "in") return false;
  if (Date.now() - existing.createdAt.getTime() < STUCK_AFTER_MS) return false;

  const [reply] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, "out"), gte(messages.createdAt, existing.createdAt)))
    .limit(1);
  if (reply) return false;
  const [draft] = await tx.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.conversationId, conversationId), gte(approvals.createdAt, existing.createdAt))).limit(1);
  if (draft) return false;
  const [handoff] = await tx.select({ id: handoffs.id }).from(handoffs).where(and(eq(handoffs.conversationId, conversationId), gte(handoffs.createdAt, existing.createdAt))).limit(1);
  return !handoff;
}

const DEFAULT_RESUME_HOURS = 4;

/**
 * Conversacion escalada a una persona que nadie atendio: si el equipo lleva `hours` horas sin escribirle al cliente
 * (ni tomar el control), el asistente retoma la conversacion cuando el cliente vuelve a escribir.
 * Se mide desde lo ultimo que hizo el equipo: su ultimo mensaje, o el aviso de escalada. 0 = nunca.
 */
async function resumeIfTeamSilent(tx: Tx, hours: number, conversationId: string, now: Date): Promise<boolean> {
  if (hours <= 0) return false;
  const [lastOut] = await tx
    .select({ at: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, "out")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const [lastHandoff] = await tx
    .select({ at: handoffs.updatedAt })
    .from(handoffs)
    .where(and(eq(handoffs.conversationId, conversationId), isNull(handoffs.resolvedAt)))
    .orderBy(desc(handoffs.updatedAt))
    .limit(1);
  const last = Math.max(lastOut?.at.getTime() ?? 0, lastHandoff?.at.getTime() ?? 0);
  if (last === 0 || now.getTime() - last < hours * 3_600_000) return false;

  await tx.update(conversations).set({ state: "bot", assignedUserId: null, updatedAt: now }).where(eq(conversations.id, conversationId));
  await tx.update(handoffs).set({ resolvedAt: now, updatedAt: now }).where(and(eq(handoffs.conversationId, conversationId), isNull(handoffs.resolvedAt)));
  return true;
}

/** Procesa UN mensaje entrante y decide que hacer con la respuesta. */
export async function runAgentTurn(input: RunTurnInput): Promise<TurnResult> {
  const { db, llm, tenantId, conversationId } = input;
  const now = input.now ?? new Date();
  const maxIterations = input.maxIterations ?? 5;

  // 1) Guardar el mensaje entrante y leer el estado, todo en una transaccion.
  const loaded = await withTenant(db, { tenantId }, async (tx) => {
    const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, conversationId));
    if (!conversation) throw new Error("Conversacion no encontrada");
    const [contact] = await tx.select().from(contacts).where(eq(contacts.id, conversation.contactId));
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId));
    const [channelRow] = await tx.select({ type: channels.type }).from(channels).where(eq(channels.id, conversation.channelId));
    const [config] = await tx.select().from(agentConfigs).where(eq(agentConfigs.tenantId, tenantId));
    if (!contact || !tenant) throw new Error("Contacto o negocio no encontrado");
    if (!config) throw new Error("El negocio no tiene configuracion de agente");

    const saved = await tx
      .insert(messages)
      .values({
        tenantId,
        conversationId,
        channelId: conversation.channelId,
        direction: "in",
        sender: "contact",
        type: input.type ?? "text",
        body: input.text || null,
        transcript: input.transcript ?? null,
        mediaUrl: input.mediaUrl ?? null,
        externalId: input.externalMessageId ?? null,
        status: "received",
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    if (saved.length === 0) {
      // Mensaje ya guardado. Normalmente es una repeticion y se ignora. PERO si el servicio se reinicio a la mitad
      // (un despliegue) el mensaje quedo guardado SIN respuesta: entonces se retoma, para que el cliente no se quede sin contestar.
      if (!input.externalMessageId || !(await isUnansweredRetry(tx, conversation.channelId, conversationId, input.externalMessageId))) {
        return { duplicate: true as const };
      }
    }

    await tx
      .update(conversations)
      .set({
        lastInboundAt: now,
        lastMessageAt: now,
        updatedAt: now,
        ...(conversation.state === "closed" ? { state: "bot" as const } : {}),
      })
      .where(eq(conversations.id, conversationId));

    if (conversation.state === "human") {
      if (!(await resumeIfTeamSilent(tx, tenant.profile?.humanResumeHours ?? DEFAULT_RESUME_HOURS, conversationId, now))) {
        return { humanControl: true as const };
      }
      conversation.state = "bot";
    }
    if (input.agentDisabledReason) return { disabled: true as const };

    const [{ n: inboundCount } = { n: 1 }] = await tx
      .select({ n: count() })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, "in")));

    const [memory] = await tx
      .select()
      .from(conversationMemory)
      .where(eq(conversationMemory.conversationId, conversationId));
    let marker: Date | null = null;
    if (memory?.summarizedUpToMessageId) {
      const [m] = await tx
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.id, memory.summarizedUpToMessageId));
      marker = m?.createdAt ?? null;
    }
    const recent = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), marker ? gt(messages.createdAt, marker) : undefined))
      .orderBy(desc(messages.createdAt))
      .limit(MAX_RAW_HISTORY);

    return {
      conversation,
      contact,
      tenant,
      config,
      channelType: channelRow?.type ?? "whatsapp",
      inboundCount: Number(inboundCount),
      summary: memory?.summary ?? "",
      history: recent.reverse(),
    };
  });

  if ("duplicate" in loaded) return nothing("duplicate");
  if ("humanControl" in loaded) return nothing("human_has_control");
  if ("disabled" in loaded) return nothing("agent_disabled");

  const { tenant, config, contact } = loaded;
  assertApprovedModel(config.model);
  if (config.fallbackModel) assertApprovedModel(config.fallbackModel);

  const mode = modeFor(config.autonomy as Autonomy);
  const ctx: TurnContext = {
    db,
    tenantId,
    tenant,
    config,
    conversationId,
    contactId: contact.id,
    contact,
    now,
    inboundCount: loaded.inboundCount,
    taskState: { ...(loaded.conversation.taskState as TaskState) },
    mode,
    proposedActions: [],
    attachments: [],
    usedMutation: false,
    escalated: false,
  };

  // 2) Armar el prompt con los datos reales de este cliente.
  const upcoming = await upcomingAppointments(ctx);
  const profileEntries = Object.entries(contact.profile ?? {});
  const systemPrompt = buildSystemPrompt({
    tenant,
    config,
    pack: resolvePack(config.packSlug),
    now,
    mode,
    contactMemory: [
      contact.displayName ? `nombre: ${contact.displayName}` : "",
      contact.phoneE164
        ? `teléfono: ${contact.phoneE164} (ya lo tienes, no lo pidas)`
        : loaded.channelType !== "whatsapp"
          ? `teléfono: AÚN NO LO TIENES (escribe por ${loaded.channelType === "instagram" ? "Instagram" : "Messenger"}). Antes de agendar pídele su número de WhatsApp a 10 dígitos y guárdalo con guardar_datos_contacto (campo telefono): los recordatorios de cita salen por WhatsApp.`
          : "",
      contact.email ? `correo: ${contact.email}` : "",
      contact.tags.length ? `etiquetas: ${contact.tags.join(", ")}` : "",
      ...profileEntries.map(([k, v]) => `${k}: ${String(v)}`),
    ]
      .filter(Boolean)
      .join("; "),
    conversationSummary: loaded.summary,
    taskStateJson: Object.keys(ctx.taskState).length > 0 ? JSON.stringify(ctx.taskState) : "{}",
    upcomingAppointments: upcoming
      .map((a) => `${a.id} | ${a.service} con ${a.staff} | ${formatLocal(a.startsAt, tenant.timezone)} | ${a.status}`)
      .join("\n"),
  });

  const chat: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...toChatHistory(loaded.history)];
  const tools = toolDefinitions();
  const dataCollection = dataCollectionFor(tenant.vertical);

  const usage = emptyUsage();
  const usageRows: Array<{ model: string; tokensIn: number; tokensOut: number; costUsdMicros: number }> = [];
  const trace: ToolRun[] = [];
  let finalText = "";
  let failure: string | undefined;

  // 3) Bucle modelo <-> herramientas (acotado).
  try {
    let finished = false;
    for (let i = 0; i < maxIterations; i++) {
      const res = await llm.chat({
        model: config.model,
        fallbackModel: config.fallbackModel ?? undefined,
        messages: chat,
        tools,
        temperature: config.temperature,
        dataCollection,
      });
      usage.calls++;
      usage.tokensIn += res.usage.promptTokens;
      usage.tokensOut += res.usage.completionTokens;
      usage.costUsd += res.usage.costUsd;
      if (!usage.models.includes(res.model)) usage.models.push(res.model);
      usage.usedFallback ||= res.usedFallback;
      usageRows.push({
        model: res.model,
        tokensIn: res.usage.promptTokens,
        tokensOut: res.usage.completionTokens,
        costUsdMicros: Math.round(res.usage.costUsd * 1_000_000),
      });

      chat.push({
        role: "assistant",
        content: res.message.content,
        ...(res.message.tool_calls ? { tool_calls: res.message.tool_calls } : {}),
      });

      const calls = res.message.tool_calls ?? [];
      if (calls.length === 0) {
        finalText = (res.message.content ?? "").trim();
        finished = true;
        break;
      }
      for (const call of calls) {
        const run = await runTool(call.function.name, call.function.arguments, ctx);
        trace.push(run);
        chat.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(run.result) });
      }
    }
    if (!finished) {
      failure = "limite_de_iteraciones";
      await forceEscalation(ctx, "Falla del asistente (no fue su decisión): dio demasiadas vueltas con sus herramientas y no logró resolver la solicitud. Revisa que el negocio tenga servicios, horarios y especialistas cargados.");
    } else if (!finalText && !ctx.escalated) {
      failure = "respuesta_vacia";
      await forceEscalation(ctx, "Falla del asistente (no fue su decisión): el modelo de IA no generó ninguna respuesta.");
    } else if (!ctx.escalated && claimsHandoff(finalText)) {
      // Le dijo al cliente que una persona lo atendera, pero nunca llamo a escalar_a_humano: se escala de verdad.
      await forceEscalation(ctx, "Escalación automática: el asistente le dijo al cliente que una persona lo atendería, pero no había escalado la conversación. Revisa qué necesita el cliente.", "pidio_persona");
    }
  } catch (error) {
    failure = error instanceof LLMError ? `llm_${error.status ?? "red"}` : "error_inesperado";
    console.error("[agent] fallo el turno:", error instanceof Error ? error.message : error);
    try {
      const hint =
        failure === "llm_429" ? "el modelo de IA está saturado o llegó al límite de uso (modo gratuito)" : failure.startsWith("llm_") ? `el modelo de IA no respondió (${failure})` : "error inesperado en el servidor";
      await forceEscalation(ctx, `Falla técnica del asistente (no fue su decisión): ${hint}. Código: ${failure}.`);
    } catch (e) {
      console.error("[agent] tampoco se pudo escalar:", e instanceof Error ? e.message : e);
    }
  }

  if (!finalText || failure) {
    finalText = failure && !ctx.escalationMessage ? TECHNICAL_ERROR_REPLY : (ctx.escalationMessage ?? TECHNICAL_ERROR_REPLY);
  }
  finalText = (loaded.channelType === "whatsapp" ? toWhatsAppText(finalText) : toPlainText(finalText)).slice(0, MAX_REPLY_CHARS);

  // 4) Politica de salida segun el nivel de autonomia.
  const decision = decideOutput({
    autonomy: config.autonomy as Autonomy,
    hasProposedActions: ctx.proposedActions.length > 0,
    escalated: ctx.escalated,
  });

  const persisted = await withTenant(db, { tenantId }, async (tx) => {
    await tx
      .update(conversations)
      .set({ taskState: ctx.taskState, lastMessageAt: now, updatedAt: now })
      .where(eq(conversations.id, conversationId));

    let messageId: string | undefined;
    let approvalId: string | undefined;
    if (decision === "send") {
      const [row] = await tx
        .insert(messages)
        .values({
          tenantId,
          conversationId,
          channelId: loaded.conversation.channelId,
          direction: "out",
          sender: "bot",
          type: "text",
          body: finalText,
          status: "queued",
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
        })
        .returning({ id: messages.id });
      messageId = row!.id;
      // Adjuntos (ubicacion): un mensaje saliente aparte, que el enviador traduce al canal.
      for (const attachment of ctx.attachments) {
        await tx.insert(messages).values({
          tenantId,
          conversationId,
          channelId: loaded.conversation.channelId,
          direction: "out",
          sender: "bot",
          type: attachment.type,
          body: JSON.stringify(attachment),
          status: "queued",
        });
      }
    } else {
      const [row] = await tx
        .insert(approvals)
        .values({ tenantId, conversationId, draft: finalText, proposedActions: ctx.proposedActions })
        .returning({ id: approvals.id });
      approvalId = row!.id;
    }

    if (usageRows.length > 0) {
      await tx.insert(usageEvents).values(
        usageRows.map((u) => ({
          tenantId,
          kind: "llm" as const,
          model: u.model,
          tokensIn: u.tokensIn,
          tokensOut: u.tokensOut,
          costUsdMicros: u.costUsdMicros,
          meta: { purpose: "conversation" },
        })),
      );
    }
    return { messageId, approvalId };
  });

  // 5) Memoria: resumir si la conversacion ya es larga (no bloquea ni rompe el turno).
  await maybeSummarize({ db, llm, tenantId, conversationId, dataCollection });

  return {
    action: decision,
    text: finalText,
    ...persisted,
    proposedActions: ctx.proposedActions,
    attachments: ctx.attachments,
    escalated: ctx.escalated,
    ...(failure ? { failure } : {}),
    toolTrace: trace,
    usage,
  };
}

/** Falla tecnica: el asistente NO decidio escalar. Se marca como "system" para que quien lo reciba lo sepa. */
async function forceEscalation(ctx: TurnContext, reason: string, kind?: "pidio_persona"): Promise<void> {
  await recordEscalation(ctx, { motivo: reason, urgencia: "normal", source: "system", ...(kind ? { kind } : {}) });
}
