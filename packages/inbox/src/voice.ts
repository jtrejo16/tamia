import { activeModules, ensureConversation, humanAvailability, loadTurnContext, runTool, toolDefinitions, type TaskState } from "@empleado/agent";
import {
  agentConfigs,
  auditLog,
  calls,
  channels,
  contacts,
  conversations,
  messages,
  resolveVoiceAgent,
  tenants,
  voiceSettings,
  withTenant,
  type Database,
} from "@empleado/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { tenantAccess } from "./billing";
import { CALL_ANALYSIS_ES, RetellError, retellModelConfig, transferDestination, type RetellClient, type RetellTool } from "./retell";
import { DEFAULT_GREETING, VOICE_TRANSFER_CHECK, VOICE_TRANSFER_TOOL, buildVoicePrompt, voiceToolNames } from "./voice-prompt";
import { can, fail, type Failure, type PanelContext, type Success } from "./types";

const scope = (ctx: PanelContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

// ----------------------------------------------------------------- ajustes (panel)

export interface VoiceSettingsView {
  enabled: boolean;
  allowBooking: boolean;
  /** Restaurante: el asistente toma pedidos por telefono (si no, solo informa el menu). */
  allowOrders: boolean;
  /** Restaurante: el asistente reserva mesa por telefono (si no, toma los datos y los pasa a una persona). */
  allowReservations: boolean;
  greeting: string;
  voiceId: string;
  phoneNumber: string;
  transferNumber: string;
  /** El agente ya existe en Retell (se sincronizo al menos una vez). */
  synced: boolean;
  lastSyncedAt: Date | null;
  /** El servidor tiene la clave de Retell: sin ella no se puede sincronizar ni recibir llamadas. */
  retellConfigured: boolean;
}

const E164 = /^\+\d{8,15}$/;
const settingsSchema = z.object({
  enabled: z.boolean(),
  allowBooking: z.boolean(),
  allowOrders: z.boolean().default(false),
  allowReservations: z.boolean().default(false),
  greeting: z.string().trim().max(300).default(""),
  voiceId: z.string().trim().max(120).regex(/^[\w.-]*$/, "El identificador de la voz solo lleva letras, números, guion y punto").default(""),
  phoneNumber: z.string().trim().refine((v) => v === "" || E164.test(v), "El número va con lada internacional, por ejemplo +529981234567").default(""),
  transferNumber: z.string().trim().refine((v) => v === "" || E164.test(v), "El número de recepción va con lada internacional, por ejemplo +529981234567").default(""),
});

export async function getVoiceSettings(db: Database, ctx: PanelContext, retellConfigured: boolean): Promise<VoiceSettingsView> {
  const [row] = await withTenant(db, scope(ctx), (tx) => tx.select().from(voiceSettings));
  return {
    enabled: row?.enabled ?? false,
    allowBooking: row?.allowBooking ?? false,
    allowOrders: row?.allowOrders ?? false,
    allowReservations: row?.allowReservations ?? false,
    greeting: row?.greeting ?? "",
    voiceId: row?.voiceId ?? "",
    phoneNumber: row?.phoneNumber ?? "",
    transferNumber: row?.transferNumber ?? "",
    synced: Boolean(row?.retellAgentId),
    lastSyncedAt: row?.lastSyncedAt ?? null,
    retellConfigured,
  };
}

export async function saveVoiceSettings(
  db: Database,
  ctx: PanelContext,
  raw: unknown,
): Promise<Success | Failure<"forbidden"> | (Failure<"invalid"> & { details: string[] })> {
  if (!can(ctx.role, "configure")) return fail("forbidden");
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid", details: parsed.error.issues.map((i) => i.message) };
  const v = parsed.data;

  await withTenant(db, scope(ctx), async (tx) => {
    const values = {
      enabled: v.enabled,
      allowBooking: v.allowBooking,
      allowOrders: v.allowOrders,
      allowReservations: v.allowReservations,
      greeting: v.greeting || null,
      voiceId: v.voiceId || null,
      phoneNumber: v.phoneNumber || null,
      transferNumber: v.transferNumber || null,
      updatedAt: new Date(),
    };
    const [existing] = await tx.select({ id: voiceSettings.id }).from(voiceSettings);
    if (existing) await tx.update(voiceSettings).set(values).where(eq(voiceSettings.id, existing.id));
    else await tx.insert(voiceSettings).values({ tenantId: ctx.tenantId, ...values });
    await tx.insert(auditLog).values({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "voice.settings",
      entity: "voice_settings",
      diff: { enabled: v.enabled, allowBooking: v.allowBooking, allowOrders: v.allowOrders, allowReservations: v.allowReservations } as never,
    });
  });
  return { ok: true };
}

export type VoiceSyncError = "forbidden" | "retell_unavailable" | "missing_voice" | "retell_rejected" | "retell_down";

/**
 * Crea o actualiza en Retell el agente de este negocio con su prompt y sus funciones (que apuntan a
 * `/api/voice/tools` del panel). Solo dueño. Despues hay que enlazar el numero de Twilio a ese agente
 * en Retell (ver docs/VOICE.md).
 */
export async function syncVoiceAgent(
  db: Database,
  retell: RetellClient | null,
  ctx: PanelContext,
  input: { baseUrl: string; defaultVoiceId?: string; economy?: { model?: string; analysisModel?: string; maxCallMs?: number; silenceMs?: number } },
): Promise<Success<{ agentId: string }> | Failure<VoiceSyncError>> {
  if (!can(ctx.role, "configure")) return fail("forbidden");
  if (!retell) return fail("retell_unavailable");

  const loaded = await withTenant(db, scope(ctx), async (tx) => {
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
    const [config] = await tx.select().from(agentConfigs).where(eq(agentConfigs.tenantId, ctx.tenantId));
    const [settings] = await tx.select().from(voiceSettings);
    return { tenant, config, settings };
  });
  if (!loaded.tenant || !loaded.config || !loaded.settings) return fail("missing_voice");
  const { tenant, config, settings } = loaded;
  const voiceId = settings.voiceId || input.defaultVoiceId;
  if (!voiceId) return fail("missing_voice");

  const base = input.baseUrl.replace(/\/$/, "");
  const transfer = Boolean(settings.transferNumber);
  // Con telefonia propia en DIDWW el destino va como direccion SIP (ver transferDestination); si no, el telefono a secas.
  const transferTo = transfer
    ? transferDestination(settings.transferNumber!, settings.phoneNumber ? await retell.getTerminationUri(settings.phoneNumber) : null)
    : "";
  const wanted = new Set(voiceToolNames(settings.allowBooking, transfer, settings.allowOrders, settings.allowReservations));
  const tools: RetellTool[] = [
    ...(transfer
      ? [
          // Consulta si hay alguien del equipo en horario: la transferencia solo se hace si dice que si.
          {
            type: "custom" as const,
            name: VOICE_TRANSFER_CHECK,
            description: "Consulta si hay una persona del equipo disponible ahora para recibir la llamada. Úsala SIEMPRE antes de transferir.",
            url: `${base}/api/voice/tools`,
            parameters: { type: "object", properties: {} },
            timeout_ms: 15_000,
            speak_during_execution: false,
            speak_after_execution: true,
          },
        ]
      : []),
    ...toolDefinitions(activeModules(tenant))
      .filter((t) => wanted.has(t.function.name))
      .map((t): RetellTool => ({
        type: "custom",
        name: t.function.name,
        description: t.function.description,
        url: `${base}/api/voice/tools`,
        parameters: t.function.parameters,
        timeout_ms: 15_000,
        speak_during_execution: false,
        speak_after_execution: true,
      })),
    { type: "end_call", name: "end_call", description: "Termina la llamada cuando el cliente ya no necesita nada más." },
    ...(transfer
      ? [
          {
            type: "transfer_call" as const,
            name: VOICE_TRANSFER_TOOL,
            description: "Pasa la llamada en vivo a una persona del equipo. Solo después de que puede_transferir diga que hay alguien disponible.",
            transfer_destination: { type: "predefined" as const, number: transferTo },
            // En frio por SIP REFER: Retell le pide a la linea (DIDWW) que reenvie la llamada. La asistida marca una llamada
            // nueva por la troncal de SALIDA, y con la linea de DIDWW (solo entrada) la rechazan (403).
            transfer_option: { type: "cold_transfer", cold_transfer_mode: "sip_refer" },
          },
        ]
      : []),
  ];
  const llm = {
    general_prompt: buildVoicePrompt({ tenant, config, allowBooking: settings.allowBooking, transfer, allowOrders: settings.allowOrders, allowReservations: settings.allowReservations }),
    begin_message: settings.greeting || DEFAULT_GREETING(tenant.name, config.assistantName),
    general_tools: tools,
    // Modelo economico (la voz es lo mas caro): ver voiceCostSettings en retell.ts.
    ...retellModelConfig(input.economy?.model),
  };
  const agent = {
    agent_name: `${tenant.name} (${tenant.slug})`.slice(0, 120),
    voice_id: voiceId,
    language: settings.language,
    webhook_url: `${base}/api/voice/webhook`,
    // Topes para no pagar minutos de mas: duracion maxima y silencio antes de colgar.
    ...(input.economy?.maxCallMs ? { max_call_duration_ms: input.economy.maxCallMs } : {}),
    ...(input.economy?.silenceMs ? { end_call_after_silence_ms: input.economy.silenceMs } : {}),
    // El analisis posterior (resumen y sentimiento) cuesta ≈ US$0.02 fijos por llamada con el modelo por defecto de Retell.
    ...(input.economy?.analysisModel ? { post_call_analysis_model: input.economy.analysisModel } : {}),
    // El resumen sale en español (con el valor por defecto de Retell sale en ingles).
    post_call_analysis_data: CALL_ANALYSIS_ES,
  };

  try {
    let llmId = settings.retellLlmId;
    let agentId = settings.retellAgentId;
    if (llmId) await retell.updateLlm(llmId, llm);
    else llmId = (await retell.createLlm(llm)).llmId;
    if (agentId) await retell.updateAgent(agentId, { ...agent, llm_id: llmId });
    else agentId = (await retell.createAgent({ ...agent, llm_id: llmId })).agentId;

    await withTenant(db, scope(ctx), async (tx) => {
      await tx.update(voiceSettings).set({ retellLlmId: llmId, retellAgentId: agentId, lastSyncedAt: new Date(), updatedAt: new Date() }).where(eq(voiceSettings.id, settings.id));
      await tx.insert(auditLog).values({ tenantId: ctx.tenantId, userId: ctx.userId, action: "voice.sync", entity: "voice_settings", entityId: agentId });
    });
    return { ok: true, agentId: agentId! };
  } catch (error) {
    if (error instanceof RetellError) return fail(error.status === 0 || error.status >= 500 ? "retell_down" : "retell_rejected");
    throw error;
  }
}

// ----------------------------------------------------------------- llamadas (avisos y funciones de Retell)

/** Lo que usamos del objeto `call` de Retell (todo opcional: Retell puede omitir campos). */
export interface RetellCall {
  call_id?: string;
  agent_id?: string;
  direction?: string;
  from_number?: string;
  to_number?: string;
  start_timestamp?: number;
  end_timestamp?: number;
  disconnection_reason?: string;
  transcript_object?: Array<{ role?: string; content?: string }>;
  call_analysis?: { call_summary?: string; user_sentiment?: string };
  /** Costo de la llamada segun Retell; `combined_cost` viene en CENTAVOS de dolar. */
  call_cost?: { combined_cost?: number };
}

/** Centavos de dolar (Retell) a millonesimas de dolar; null si no vino un numero valido. */
export function retellCostMicros(call: Pick<RetellCall, "call_cost">): number | null {
  const cents = call.call_cost?.combined_cost;
  return typeof cents === "number" && Number.isFinite(cents) && cents >= 0 ? Math.round(cents * 10_000) : null;
}

/** Telefono del que llama, en el mismo formato que los contactos; null si es anonimo o no parece telefono. */
export function callerPhone(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/[^\d+]/g, "");
  return /^\+\d{8,15}$/.test(d) ? d : null;
}

/** Un mismo numero mexicano puede estar guardado con o sin el "1" despues del 52 (WhatsApp lo trae con "1"). */
function phoneVariants(e164: string): string[] {
  const out = new Set([e164]);
  const m = /^\+52(1?)(\d{10})$/.exec(e164);
  if (m) {
    out.add(`+52${m[2]}`);
    out.add(`+521${m[2]}`);
  }
  return [...out];
}

interface CallRow {
  id: string;
  conversationId: string | null;
  status: string;
  startedAt: Date | null;
  taskState: Record<string, unknown>;
}

/** Idempotente: crea (o recupera) la llamada y la conversacion de voz del cliente. */
async function ensureCall(db: Database, tenantId: string, call: RetellCall): Promise<CallRow | null> {
  if (!call.call_id) return null;
  const callId = call.call_id;
  const found = await withTenant(db, { tenantId }, (tx) => tx.select().from(calls).where(eq(calls.retellCallId, callId)));
  if (found[0]) return found[0] as CallRow;

  // Canal de voz del negocio (uno por negocio; sin credenciales).
  const channelId = await withTenant(db, { tenantId }, async (tx) => {
    const [existing] = await tx.select({ id: channels.id }).from(channels).where(eq(channels.type, "voice")).limit(1);
    if (existing) return existing.id;
    const [settings] = await tx.select().from(voiceSettings);
    const [created] = await tx
      .insert(channels)
      // El identificador del canal es unico entre TODOS los negocios: se liga al negocio, no al numero.
      .values({ tenantId, type: "voice", externalId: `voice:${tenantId}`, displayPhone: settings?.phoneNumber ?? null })
      .onConflictDoNothing()
      .returning({ id: channels.id });
    if (created) return created.id;
    const [again] = await tx.select({ id: channels.id }).from(channels).where(eq(channels.type, "voice")).limit(1);
    return again?.id ?? null;
  });
  if (!channelId) return null;

  const phone = callerPhone(call.from_number);
  let ref: { conversationId: string; contactId: string };
  if (phone) {
    const known = await withTenant(db, { tenantId }, (tx) =>
      tx.select({ phone: contacts.phoneE164 }).from(contacts).where(inArray(contacts.phoneE164, phoneVariants(phone))).limit(1),
    );
    ref = await ensureConversation(db, { tenantId, channelId, phone: known[0]?.phone ?? phone });
  } else {
    // Numero oculto: un contacto por llamada, identificado por la llamada.
    ref = await ensureConversation(db, { tenantId, channelId, identity: { externalId: `call:${callId}` } });
  }

  const startedAt = call.start_timestamp ? new Date(call.start_timestamp) : new Date();
  await withTenant(db, { tenantId }, (tx) =>
    tx
      .insert(calls)
      .values({
        tenantId,
        conversationId: ref.conversationId,
        contactId: ref.contactId,
        retellCallId: callId,
        direction: call.direction === "outbound" ? "outbound" : "inbound",
        fromNumber: call.from_number ?? null,
        toNumber: call.to_number ?? null,
        startedAt,
      })
      .onConflictDoNothing(),
  );
  const [row] = await withTenant(db, { tenantId }, (tx) => tx.select().from(calls).where(eq(calls.retellCallId, callId)));
  return (row as CallRow | undefined) ?? null;
}

export type CallEvent = "call_started" | "call_ended" | "call_analyzed";

/** Aviso de Retell (inicio, fin, analisis). Devuelve si se aplico a alguno de nuestros negocios. */
export async function handleCallEvent(db: Database, event: { event: string; call: RetellCall }): Promise<{ handled: boolean }> {
  const call = event.call;
  if (!call?.agent_id || !call.call_id) return { handled: false };
  const tenantId = await resolveVoiceAgent(db, call.agent_id);
  if (!tenantId) return { handled: false };
  const row = await ensureCall(db, tenantId, call);
  if (!row) return { handled: false };

  if (event.event === "call_ended") {
    const startedAt = call.start_timestamp ? new Date(call.start_timestamp) : row.startedAt;
    const endedAt = call.end_timestamp ? new Date(call.end_timestamp) : new Date();
    const duration = startedAt ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)) : null;
    const reason = call.disconnection_reason ?? null;
    await withTenant(db, { tenantId }, async (tx) => {
      await tx
        .update(calls)
        .set({ status: reason?.startsWith("error") ? "failed" : "ended", endedAt, durationSeconds: duration, disconnectionReason: reason, ...(retellCostMicros(call) !== null ? { costUsdMicros: retellCostMicros(call) } : {}), updatedAt: new Date() })
        .where(eq(calls.id, row.id));
      // La transcripcion pasa a ser mensajes de la conversacion de voz: se ve en la bandeja.
      if (row.conversationId && call.transcript_object?.length) {
        const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, row.conversationId));
        if (conversation) {
          const base = (startedAt ?? endedAt).getTime();
          const turns = call.transcript_object.filter((t) => (t.content ?? "").trim() && (t.role === "user" || t.role === "agent"));
          for (const [i, t] of turns.entries()) {
            const inbound = t.role === "user";
            await tx
              .insert(messages)
              .values({
                tenantId,
                conversationId: conversation.id,
                channelId: conversation.channelId,
                direction: inbound ? "in" : "out",
                sender: inbound ? "contact" : "bot",
                type: "text",
                body: t.content!.trim(),
                externalId: `${call.call_id}:${i}`,
                status: inbound ? "received" : "delivered",
                createdAt: new Date(base + i * 1000),
              })
              .onConflictDoNothing();
          }
          await tx
            .update(conversations)
            .set({ lastInboundAt: endedAt, lastMessageAt: endedAt, updatedAt: new Date() })
            .where(eq(conversations.id, conversation.id));
        }
      }
    });
  } else if (event.event === "call_analyzed") {
    await withTenant(db, { tenantId }, (tx) =>
      tx
        .update(calls)
        .set({
          summary: call.call_analysis?.call_summary ?? null,
          sentiment: call.call_analysis?.user_sentiment ?? null,
          ...(retellCostMicros(call) !== null ? { costUsdMicros: retellCostMicros(call) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(calls.id, row.id)),
    );
  }
  return { handled: true };
}

/** Segundos minimos entre proponer y confirmar cuando Retell no manda la transcripcion (nadie contesta antes). */
const MIN_CONFIRM_MS = 4000;

/**
 * Una funcion que el agente de voz pidio ejecutar. Mismas herramientas y mismas reglas que WhatsApp
 * (incluida la confirmacion impuesta por codigo): la confirmacion debe llegar en un turno POSTERIOR del
 * cliente, que se cuenta con la transcripcion de la llamada.
 */
export async function runVoiceTool(
  db: Database,
  req: { call: RetellCall; name: string; args: unknown },
  options: { now?: Date } = {},
): Promise<Record<string, unknown>> {
  const call = req.call;
  if (!call?.agent_id || !call.call_id) return { error: "llamada_invalida" };
  const tenantId = await resolveVoiceAgent(db, call.agent_id);
  if (!tenantId) return { error: "agente_desconocido" };

  const access = await tenantAccess(db, tenantId);
  if (!access.allowed) {
    return { error: "servicio_no_disponible", instruccion: "Discúlpate: el servicio no está disponible en este momento y pide que llamen más tarde. Despídete." };
  }
  const [settings] = await withTenant(db, { tenantId }, (tx) => tx.select().from(voiceSettings));
  if (!settings?.enabled) return { error: "voz_desactivada" };
  if (!voiceToolNames(settings.allowBooking, Boolean(settings.transferNumber), settings.allowOrders, settings.allowReservations).includes(req.name)) {
    return { error: "herramienta_no_permitida", instruccion: "Esa acción no está disponible por teléfono. Pasa a una persona con escalar_a_humano." };
  }

  const row = await ensureCall(db, tenantId, call);
  if (!row?.conversationId) return { error: "llamada_no_registrada" };
  // Solo se ejecutan funciones de una llamada EN CURSO: una peticion repetida despues de colgar no hace nada.
  if (row.status !== "ongoing") return { error: "llamada_terminada" };

  const now = options.now ?? new Date();
  const ctx = await loadTurnContext(db, tenantId, row.conversationId, { now, mode: "live" });
  ctx.taskState = { ...(row.taskState as TaskState) };

  // Turnos del cliente hasta ahora: base de la regla "confirmar en un turno posterior".
  const userTurns = call.transcript_object?.filter((t) => t.role === "user").length;
  if (userTurns !== undefined) ctx.inboundCount = userTurns;
  else {
    const pending = ctx.taskState.pendingAction;
    const base = pending?.inboundCount ?? 0;
    ctx.inboundCount = pending && now.getTime() - new Date(pending.createdAt).getTime() >= MIN_CONFIRM_MS ? base + 1 : base;
  }

  // Funcion propia de voz: ¿hay una persona en horario para recibir la transferencia?
  if (req.name === VOICE_TRANSFER_CHECK) {
    const a = humanAvailability(ctx.tenant.humanHours, now, ctx.tenant.timezone);
    return a.openNow
      ? { disponible: true, instruccion: "Sí hay alguien disponible. Avisa en una frase que lo pasas con una persona del equipo y usa transferir_a_persona." }
      : {
          disponible: false,
          motivo: "fuera_de_horario",
          instruccion: `No transfieras. Dile con calidez que ahora no hay nadie${a.nextOpenText ? ` y que atienden ${a.nextOpenText}` : ""}, y usa escalar_a_humano para dejar su recado.`,
        };
  }

  const run = await runTool(req.name, JSON.stringify(req.args ?? {}), ctx);

  await withTenant(db, { tenantId }, (tx) =>
    tx.update(calls).set({ taskState: ctx.taskState as Record<string, unknown>, updatedAt: new Date() }).where(eq(calls.id, row.id)),
  );
  return ctx.escalated && ctx.escalationMessage ? { ...run.result, mensaje_para_el_cliente: ctx.escalationMessage } : run.result;
}

// ----------------------------------------------------------------- panel: historial de llamadas

export interface CallView {
  id: string;
  conversationId: string | null;
  contactName: string;
  phone: string | null;
  direction: "inbound" | "outbound";
  status: string;
  startedAt: Date | null;
  durationSeconds: number | null;
  summary: string | null;
  sentiment: string | null;
  disconnectionReason: string | null;
}

export async function listCalls(db: Database, ctx: PanelContext, options: { limit?: number } = {}): Promise<CallView[]> {
  const rows = await withTenant(db, scope(ctx), (tx) =>
    tx
      .select({ c: calls, contact: contacts })
      .from(calls)
      .leftJoin(contacts, eq(contacts.id, calls.contactId))
      .where(and())
      .orderBy(desc(calls.startedAt))
      .limit(Math.min(options.limit ?? 50, 200)),
  );
  return rows.map(({ c, contact }) => ({
    id: c.id,
    conversationId: c.conversationId,
    contactName: contact?.displayName ?? contact?.phoneE164 ?? "Llamada sin número",
    phone: contact?.phoneE164 ?? callerPhone(c.fromNumber ?? undefined),
    direction: c.direction === "outbound" ? "outbound" : "inbound",
    status: c.status,
    startedAt: c.startedAt,
    durationSeconds: c.durationSeconds,
    summary: c.summary,
    sentiment: c.sentiment,
    disconnectionReason: c.disconnectionReason,
  }));
}
