import { createHmac } from "node:crypto";
import { appointments, calls, channels, contacts, conversations, handoffs, messages, subscriptions, tenants, voiceSettings } from "@empleado/db";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RetellClient,
  buildVoicePrompt,
  getVoiceSettings,
  handleCallEvent,
  listCalls,
  runVoiceTool,
  saveVoiceSettings,
  sendHumanMessage,
  syncVoiceAgent,
  transferDestination,
  verifyRetellSignature,
  voiceCostSettings,
  voiceToolNames,
  type RetellCall,
} from "../src";
import { NOW, TUESDAY_10, dropWorld, makeWorld, openDbs, type Dbs, type World } from "./helpers";

let dbs: Dbs;
const worlds: World[] = [];
beforeAll(() => {
  dbs = openDbs();
});
afterAll(async () => {
  for (const w of worlds) await dropWorld(dbs.owner, w);
  await dbs.app.close();
  await dbs.owner.close();
});

const uid = () => Math.random().toString(36).slice(2, 10);
const digits10 = () => String(Math.floor(9e9 + Math.random() * 9e8)).slice(0, 10);

async function world() {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  await dbs.owner.db.insert(subscriptions).values({ tenantId: w.tenantId, status: "comped" }); // con acceso vigente
  return w;
}

/** Retell falso: guarda lo que se le manda y responde como la API. */
function fakeRetell(over: { status?: number; termination?: string; phoneLookupFails?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path: u.pathname, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    if (u.pathname.startsWith("/get-phone-number/")) {
      if (over.phoneLookupFails || !over.termination) return json({ message: "no existe" }, 404);
      return json({ phone_number: decodeURIComponent(u.pathname.split("/").pop()!), sip_outbound_trunk_config: { termination_uri: over.termination } });
    }
    if (over.status) return json({ message: "rechazado" }, over.status);
    if (u.pathname === "/create-retell-llm") return json({ llm_id: `llm_${uid()}` });
    if (u.pathname === "/create-agent") return json({ agent_id: `agent_${uid()}` });
    return json({});
  }) as typeof fetch;
  return { client: new RetellClient({ apiKey: "key_test", baseUrl: "https://retell.test", fetch: fetchFake }), calls };
}

/** Un negocio con voz activada y el agente ya creado en Retell. */
async function voiceWorld(opts: { allowBooking?: boolean } = {}) {
  const w = await world();
  expect(await saveVoiceSettings(dbs.app.db, w.owner, { enabled: true, allowBooking: opts.allowBooking ?? false, greeting: "", voiceId: "voz-es-mx", phoneNumber: "+529981110000" })).toEqual({ ok: true });
  const { client, calls: retellCalls } = fakeRetell();
  const sync = await syncVoiceAgent(dbs.app.db, client, w.owner, { baseUrl: "https://panel.test" });
  if (!sync.ok) throw new Error(`sync fallo: ${sync.error}`);
  return { w, agentId: sync.agentId, retellCalls };
}

const call = (agentId: string, over: Partial<RetellCall> = {}): RetellCall => ({
  call_id: `call_${uid()}`,
  agent_id: agentId,
  direction: "inbound",
  from_number: `+52${digits10()}`,
  to_number: "+529981110000",
  start_timestamp: NOW.getTime(),
  ...over,
});

describe("firma de los avisos de Retell", () => {
  const key = "key_de_prueba";
  const body = JSON.stringify({ event: "call_started" });
  const now = 1_800_000_000_000;
  const sign = (ts: string) => `v=${ts},d=${createHmac("sha256", key).update(body + ts).digest("hex")}`;

  it("acepta la firma con marca de tiempo y la del formato anterior", () => {
    expect(verifyRetellSignature({ body, apiKey: key, signature: sign(String(now)), now })).toBe(true);
    expect(verifyRetellSignature({ body, apiKey: key, signature: createHmac("sha256", key).update(body).digest("hex"), now })).toBe(true);
  });

  it("rechaza cuerpo alterado, otra clave, firma vieja, vacia o con basura", () => {
    const good = sign(String(now));
    expect(verifyRetellSignature({ body: body + " ", apiKey: key, signature: good, now })).toBe(false);
    expect(verifyRetellSignature({ body, apiKey: "otra", signature: good, now })).toBe(false);
    expect(verifyRetellSignature({ body, apiKey: key, signature: sign(String(now - 6 * 60_000)), now })).toBe(false);
    expect(verifyRetellSignature({ body, apiKey: key, signature: null, now })).toBe(false);
    expect(verifyRetellSignature({ body, apiKey: key, signature: "basura", now })).toBe(false);
    expect(verifyRetellSignature({ body, apiKey: "", signature: good, now })).toBe(false);
  });
});

describe("prompt del agente de voz", () => {
  it("lleva los datos reales del negocio y las reglas de voz; sin agendar si no se permite", async () => {
    const w = await world();
    const { client, calls: rc } = fakeRetell();
    await saveVoiceSettings(dbs.app.db, w.owner, { enabled: true, allowBooking: false, voiceId: "v1" });
    await syncVoiceAgent(dbs.app.db, client, w.owner, { baseUrl: "https://panel.test" });
    const prompt: string = rc.find((c) => c.path === "/create-retell-llm")!.body.general_prompt;
    expect(prompt).toContain("Clínica Panel");
    expect(prompt).toContain("{{current_time}}");
    expect(prompt).toContain("Frases cortas");
    expect(prompt).toContain("NO puedes crear, cambiar ni cancelar citas");
    expect(prompt).toContain("escalar_a_humano");
  });

  it("si se permite agendar, exige confirmacion explicita antes de ejecutar", () => {
    const base = { tenant: { name: "X", timezone: "America/Merida", profile: {}, slug: "x" } as never, config: { assistantName: "Sonri", tone: "cálido", formality: "usted", escalationRules: [], forbiddenTopics: [] } as never };
    const prompt = buildVoicePrompt({ ...base, allowBooking: true });
    expect(prompt).toContain("¿Te lo confirmo?");
    expect(prompt).toContain("confirmado en verdadero");
    expect(voiceToolNames(true)).toEqual(expect.arrayContaining(["crear_cita", "cancelar_cita"]));
    expect(voiceToolNames(false)).not.toContain("crear_cita");
  });
});

describe("ajustes y sincronizacion con Retell", () => {
  it("solo el dueño guarda; el numero debe ser internacional; valores invalidos se rechazan", async () => {
    const w = await world();
    const ok = { enabled: true, allowBooking: false, greeting: "", voiceId: "v1", phoneNumber: "+529981234567" };
    expect(await saveVoiceSettings(dbs.app.db, w.agent, ok)).toEqual({ ok: false, error: "forbidden" });
    expect(await saveVoiceSettings(dbs.app.db, w.owner, { ...ok, phoneNumber: "9981234567" })).toMatchObject({ ok: false, error: "invalid" });
    expect(await saveVoiceSettings(dbs.app.db, w.owner, { ...ok, voiceId: "con espacios!" })).toMatchObject({ ok: false, error: "invalid" });
    expect(await saveVoiceSettings(dbs.app.db, w.owner, ok)).toEqual({ ok: true });
    expect(await getVoiceSettings(dbs.app.db, w.owner, true)).toMatchObject({ enabled: true, phoneNumber: "+529981234567", synced: false, retellConfigured: true });
  });

  it("primera vez CREA el modelo y el agente con las funciones apuntando al panel; despues solo actualiza", async () => {
    const w = await world();
    await saveVoiceSettings(dbs.app.db, w.owner, { enabled: true, allowBooking: true, voiceId: "voz-1" });
    const { client, calls: rc } = fakeRetell();
    const first = await syncVoiceAgent(dbs.app.db, client, w.owner, { baseUrl: "https://panel.test/" });
    expect(first.ok).toBe(true);

    const llm = rc.find((c) => c.path === "/create-retell-llm")!.body;
    const custom = llm.general_tools.filter((t: any) => t.type === "custom");
    expect(custom.every((t: any) => t.url === "https://panel.test/api/voice/tools")).toBe(true);
    expect(custom.map((t: any) => t.name)).toEqual(expect.arrayContaining(["crear_cita", "buscar_disponibilidad", "escalar_a_humano"]));
    expect(llm.general_tools.some((t: any) => t.type === "end_call")).toBe(true);
    const agent = rc.find((c) => c.path === "/create-agent")!.body;
    expect(agent).toMatchObject({ voice_id: "voz-1", language: "es-419", webhook_url: "https://panel.test/api/voice/webhook" });

    const second = await syncVoiceAgent(dbs.app.db, client, w.owner, { baseUrl: "https://panel.test" });
    expect(second).toEqual(first);
    expect(rc.filter((c) => c.path === "/create-retell-llm")).toHaveLength(1);
    expect(rc.some((c) => c.method === "PATCH" && c.path.startsWith("/update-retell-llm/"))).toBe(true);
    expect(rc.some((c) => c.method === "PATCH" && c.path.startsWith("/update-agent/"))).toBe(true);
  });

  it("manda a Retell el modelo economico y los topes de duracion y silencio (crear y actualizar)", async () => {
    const w = await world();
    await saveVoiceSettings(dbs.app.db, w.owner, { enabled: true, allowBooking: true, voiceId: "voz-1" });
    const { client, calls: rc } = fakeRetell();
    const economy = voiceCostSettings({});
    await syncVoiceAgent(dbs.app.db, client, w.owner, { baseUrl: "https://panel.test", economy });
    // Retell ignora el campo antiguo `model` si el modelo ya trae `model_config`: se manda el actual.
    expect(rc.find((c) => c.path === "/create-retell-llm")!.body.model_config).toEqual({ type: "cascading", primary: { model: "gpt-5.6-luna", tier: "standard" } });
    expect(rc.find((c) => c.path === "/create-retell-llm")!.body).not.toHaveProperty("model");
    expect(rc.find((c) => c.path === "/create-agent")!.body).toMatchObject({ max_call_duration_ms: 600_000, end_call_after_silence_ms: 20_000, post_call_analysis_model: "claude-5.5-haiku" });
    await syncVoiceAgent(dbs.app.db, client, w.owner, { baseUrl: "https://panel.test", economy });
    expect(rc.find((c) => c.path.startsWith("/update-retell-llm/"))!.body.model_config).toEqual({ type: "cascading", primary: { model: "gpt-5.6-luna", tier: "standard" } });
    expect(rc.find((c) => c.path.startsWith("/update-agent/"))!.body).toMatchObject({ max_call_duration_ms: 600_000, end_call_after_silence_ms: 20_000, post_call_analysis_model: "claude-5.5-haiku" });

    // El resumen de la llamada se pide en español (Retell lo hace en ingles si no se le indica).
    const analysis = rc.find((c) => c.path === "/create-agent")!.body.post_call_analysis_data;
    expect(analysis).toHaveLength(1);
    expect(analysis[0]).toMatchObject({ type: "system-presets", name: "call_summary" });
    expect(analysis[0].description).toMatch(/ESPAÑOL/);
    expect(rc.find((c) => c.path.startsWith("/update-agent/"))!.body.post_call_analysis_data).toEqual(analysis);

    // Sin ajustes (llamadas anteriores del codigo): no se manda modelo ni topes y Retell usa los suyos.
    const w2 = await world();
    await saveVoiceSettings(dbs.app.db, w2.owner, { enabled: true, allowBooking: false, voiceId: "v2" });
    const fake2 = fakeRetell();
    await syncVoiceAgent(dbs.app.db, fake2.client, w2.owner, { baseUrl: "https://panel.test" });
    expect(fake2.calls.find((c) => c.path === "/create-retell-llm")!.body).not.toHaveProperty("model_config");
    expect(fake2.calls.find((c) => c.path === "/create-agent")!.body).not.toHaveProperty("max_call_duration_ms");
  });

  it("lee los ajustes de costo del entorno y descarta valores fuera de rango", () => {
    expect(voiceCostSettings({})).toEqual({ model: "gpt-5.6-luna", analysisModel: "claude-5.5-haiku", maxCallMs: 600_000, silenceMs: 20_000 });
    expect(voiceCostSettings({ RETELL_LLM_MODEL: "gpt-5-nano", VOICE_MAX_CALL_MINUTES: "5", VOICE_SILENCE_SECONDS: "30" })).toEqual({ model: "gpt-5-nano", analysisModel: "claude-5.5-haiku", maxCallMs: 300_000, silenceMs: 30_000 });
    // "default" o vacio: se usa el modelo de Retell (no se manda ninguno).
    expect(voiceCostSettings({ RETELL_LLM_MODEL: "default" }).model).toBeUndefined();
    expect(voiceCostSettings({ RETELL_ANALYSIS_MODEL: "default" }).analysisModel).toBeUndefined();
    expect(voiceCostSettings({ RETELL_ANALYSIS_MODEL: "gpt-5-nano" }).analysisModel).toBe("gpt-5-nano");
    expect(voiceCostSettings({ RETELL_LLM_MODEL: "" }).model).toBeUndefined();
    // Basura: vuelven a los valores recomendados (Retell exige minimo 10 s de silencio y 1 min de llamada).
    expect(voiceCostSettings({ RETELL_LLM_MODEL: "raro; drop table", VOICE_MAX_CALL_MINUTES: "0", VOICE_SILENCE_SECONDS: "3" })).toEqual({ model: "gpt-5.6-luna", analysisModel: "claude-5.5-haiku", maxCallMs: 600_000, silenceMs: 20_000 });
    expect(voiceCostSettings({ VOICE_MAX_CALL_MINUTES: "500", VOICE_SILENCE_SECONDS: "abc" })).toMatchObject({ maxCallMs: 600_000, silenceMs: 20_000 });
  });

  it("sin agendar, el agente NO recibe las funciones de agenda", async () => {
    const { retellCalls } = await voiceWorld({ allowBooking: false });
    const names = retellCalls.find((c) => c.path === "/create-retell-llm")!.body.general_tools.map((t: any) => t.name);
    expect(names).not.toContain("crear_cita");
    expect(names).not.toContain("cancelar_cita");
    expect(names).toContain("buscar_citas_del_contacto");
  });

  it("errores claros: sin permiso, sin Retell, sin voz, Retell rechaza o cae", async () => {
    const w = await world();
    const { client } = fakeRetell();
    const input = { baseUrl: "https://panel.test" };
    expect(await syncVoiceAgent(dbs.app.db, client, w.agent, input)).toEqual({ ok: false, error: "forbidden" });
    expect(await syncVoiceAgent(dbs.app.db, null, w.owner, input)).toEqual({ ok: false, error: "retell_unavailable" });
    expect(await syncVoiceAgent(dbs.app.db, client, w.owner, input)).toEqual({ ok: false, error: "missing_voice" });
    await saveVoiceSettings(dbs.app.db, w.owner, { enabled: true, allowBooking: false });
    expect(await syncVoiceAgent(dbs.app.db, client, w.owner, input)).toEqual({ ok: false, error: "missing_voice" });
    expect((await syncVoiceAgent(dbs.app.db, client, w.owner, { ...input, defaultVoiceId: "por-defecto" })).ok).toBe(true);

    const w2 = await world();
    await saveVoiceSettings(dbs.app.db, w2.owner, { enabled: true, allowBooking: false, voiceId: "v" });
    expect(await syncVoiceAgent(dbs.app.db, fakeRetell({ status: 422 }).client, w2.owner, input)).toEqual({ ok: false, error: "retell_rejected" });
    expect(await syncVoiceAgent(dbs.app.db, fakeRetell({ status: 503 }).client, w2.owner, input)).toEqual({ ok: false, error: "retell_down" });
  });
});

describe("llamadas: avisos de Retell", () => {
  it("una llamada de un cliente conocido (con o sin el '1' del 52) cae en SU contacto, en un canal de voz", async () => {
    const { w, agentId } = await voiceWorld();
    const ten = digits10();
    const [known] = await dbs.owner.db.insert(contacts).values({ tenantId: w.tenantId, phoneE164: `+521${ten}`, displayName: "Ana WhatsApp" }).returning();

    const c = call(agentId, { from_number: `+52${ten}` });
    expect(await handleCallEvent(dbs.app.db, { event: "call_started", call: c })).toEqual({ handled: true });

    const [row] = await dbs.owner.db.select().from(calls).where(eq(calls.retellCallId, c.call_id!));
    expect(row).toMatchObject({ tenantId: w.tenantId, contactId: known!.id, direction: "inbound", status: "ongoing" });
    const [channel] = await dbs.owner.db.select().from(channels).where(and(eq(channels.tenantId, w.tenantId), eq(channels.type, "voice")));
    const [conv] = await dbs.owner.db.select().from(conversations).where(eq(conversations.id, row!.conversationId!));
    expect(conv!.channelId).toBe(channel!.id);
    const all = await dbs.owner.db.select().from(contacts).where(eq(contacts.tenantId, w.tenantId));
    expect(all.filter((x) => x.displayName === "Ana WhatsApp")).toHaveLength(1); // no se duplico
  });

  it("numero oculto: un contacto propio por llamada, sin telefono", async () => {
    const { w, agentId } = await voiceWorld();
    const c = call(agentId, { from_number: "anonymous" });
    await handleCallEvent(dbs.app.db, { event: "call_started", call: c });
    const [row] = await dbs.owner.db.select().from(calls).where(eq(calls.retellCallId, c.call_id!));
    const [contact] = await dbs.owner.db.select().from(contacts).where(eq(contacts.id, row!.contactId!));
    expect(contact!.phoneE164).toBeNull();
    expect(contact!.tenantId).toBe(w.tenantId);
  });

  it("al terminar guarda duracion y la TRANSCRIPCION como mensajes en orden; el resumen llega despues; reenviar no duplica", async () => {
    const { w, agentId } = await voiceWorld();
    const c = call(agentId, { start_timestamp: NOW.getTime() });
    const ended: RetellCall = {
      ...c,
      end_timestamp: NOW.getTime() + 95_000,
      disconnection_reason: "user_hangup",
      transcript_object: [
        { role: "agent", content: "Hola, gracias por llamar a Clínica Panel." },
        { role: "user", content: "Quiero una limpieza dental." },
        { role: "agent", content: "Claro, ¿para qué día?" },
        { role: "user", content: "   " },
      ],
    };
    await handleCallEvent(dbs.app.db, { event: "call_started", call: c });
    await handleCallEvent(dbs.app.db, { event: "call_ended", call: ended });
    await handleCallEvent(dbs.app.db, { event: "call_ended", call: ended }); // reintento de Retell
    await handleCallEvent(dbs.app.db, { event: "call_analyzed", call: { ...ended, call_analysis: { call_summary: "Quiere una limpieza.", user_sentiment: "Positive" } } });

    const [row] = await dbs.owner.db.select().from(calls).where(eq(calls.retellCallId, c.call_id!));
    expect(row).toMatchObject({ status: "ended", durationSeconds: 95, disconnectionReason: "user_hangup", summary: "Quiere una limpieza.", sentiment: "Positive" });
    const rows = await dbs.owner.db.select().from(messages).where(eq(messages.conversationId, row!.conversationId!)).orderBy(asc(messages.createdAt));
    expect(rows.map((m) => [m.direction, m.sender, m.body])).toEqual([
      ["out", "bot", "Hola, gracias por llamar a Clínica Panel."],
      ["in", "contact", "Quiero una limpieza dental."],
      ["out", "bot", "Claro, ¿para qué día?"],
    ]);
    expect(w.tenantId).toBe(row!.tenantId);
  });

  it("ignora agentes desconocidos y negocios con voz desactivada", async () => {
    const { w, agentId } = await voiceWorld();
    expect(await handleCallEvent(dbs.app.db, { event: "call_started", call: call("agent_que_no_existe") })).toEqual({ handled: false });
    await saveVoiceSettings(dbs.app.db, w.owner, { enabled: false, allowBooking: false, voiceId: "voz-es-mx" });
    expect(await handleCallEvent(dbs.app.db, { event: "call_started", call: call(agentId) })).toEqual({ handled: false });
    expect(await handleCallEvent(dbs.app.db, { event: "call_started", call: {} })).toEqual({ handled: false });
  });

  it("el historial solo muestra las llamadas de MI negocio", async () => {
    const a = await voiceWorld();
    const b = await voiceWorld();
    const ca = call(a.agentId);
    const cb = call(b.agentId);
    await handleCallEvent(dbs.app.db, { event: "call_started", call: ca });
    await handleCallEvent(dbs.app.db, { event: "call_started", call: cb });
    const listA = await listCalls(dbs.app.db, a.w.owner);
    expect(listA).toHaveLength(1);
    expect(listA[0]).toMatchObject({ direction: "inbound", status: "ongoing" });
    expect((await listCalls(dbs.app.db, b.w.owner)).map((c) => c.phone)).toEqual([cb.from_number]);
  });

  it("una llamada no se responde por texto desde la bandeja", async () => {
    const { w, agentId } = await voiceWorld();
    const c = call(agentId);
    await handleCallEvent(dbs.app.db, { event: "call_started", call: c });
    const [row] = await dbs.owner.db.select().from(calls).where(eq(calls.retellCallId, c.call_id!));
    await dbs.owner.db.update(conversations).set({ state: "human", assignedUserId: w.ownerId, lastInboundAt: NOW }).where(eq(conversations.id, row!.conversationId!));
    const res = await sendHumanMessage(dbs.app.db, w.owner, row!.conversationId!, "Hola", async () => {}, NOW);
    expect(res).toEqual({ ok: false, error: "voice_channel" });
  });
});

describe("llamadas: funciones del agente de voz", () => {
  it("consulta datos REALES del negocio con las mismas herramientas que WhatsApp", async () => {
    const { w, agentId } = await voiceWorld();
    const c = call(agentId);
    await handleCallEvent(dbs.app.db, { event: "call_started", call: c });
    const r = await runVoiceTool(dbs.app.db, { call: c, name: "consultar_servicios", args: {} }, { now: NOW });
    expect(JSON.stringify(r)).toContain("Limpieza dental");
    expect(JSON.stringify(r)).toContain(w.serviceId);
  });

  it("sin permiso para agendar, crear_cita se rechaza (y nada se escribe)", async () => {
    const { w, agentId } = await voiceWorld({ allowBooking: false });
    const c = call(agentId);
    await handleCallEvent(dbs.app.db, { event: "call_started", call: c });
    const r = await runVoiceTool(dbs.app.db, { call: c, name: "crear_cita", args: { servicio_id: w.serviceId, empleado_id: w.staffId, inicio_iso: TUESDAY_10, confirmado: true } }, { now: NOW });
    expect(r.error).toBe("herramienta_no_permitida");
    expect(await dbs.owner.db.select().from(appointments).where(eq(appointments.tenantId, w.tenantId))).toHaveLength(0);
  });

  it("agendar exige proponer, que el cliente RESPONDA en un turno posterior y confirmar con los mismos datos", async () => {
    const { w, agentId } = await voiceWorld({ allowBooking: true });
    const c = call(agentId);
    await handleCallEvent(dbs.app.db, { event: "call_started", call: c });
    // un cliente nuevo debe dar su nombre completo antes de agendar (lo exige la herramienta)
    expect((await runVoiceTool(dbs.app.db, { call: c, name: "guardar_datos_contacto", args: { nombre: "Ana Pérez Gómez" } }, { now: NOW })).ok).toBe(true);
    const args = { servicio_id: w.serviceId, empleado_id: w.staffId, inicio_iso: TUESDAY_10 };
    const turns = (n: number) => ({ ...c, transcript_object: Array.from({ length: n }, () => ({ role: "user", content: "sí" })) });

    // 1) propone: no escribe, devuelve el resumen para que el agente lo lea al cliente
    const t0 = new Date(NOW.getTime());
    const proposal = await runVoiceTool(dbs.app.db, { call: turns(1), name: "crear_cita", args: { ...args, confirmado: false } }, { now: t0 });
    expect(proposal.requiere_confirmacion).toBe(true);
    expect(await dbs.owner.db.select().from(appointments).where(eq(appointments.tenantId, w.tenantId))).toHaveLength(0);

    // 2) el modelo insiste en el MISMO turno (el cliente no ha dicho nada nuevo): no se ejecuta
    const same = await runVoiceTool(dbs.app.db, { call: turns(1), name: "crear_cita", args: { ...args, confirmado: true } }, { now: new Date(t0.getTime() + 2000) });
    expect(same.error).toBe("falta_confirmacion");
    expect(await dbs.owner.db.select().from(appointments).where(eq(appointments.tenantId, w.tenantId))).toHaveLength(0);

    // 3) el cliente contesto ("sí"): hay un turno mas y ya se agenda
    const done = await runVoiceTool(dbs.app.db, { call: turns(2), name: "crear_cita", args: { ...args, confirmado: true } }, { now: new Date(t0.getTime() + 9000) });
    expect(done.ok).toBe(true);
    const appts = await dbs.owner.db.select().from(appointments).where(eq(appointments.tenantId, w.tenantId));
    expect(appts).toHaveLength(1);
    expect(appts[0]).toMatchObject({ serviceId: w.serviceId, staffId: w.staffId });
  });

  it("sin transcripcion de Retell, la confirmacion necesita que pasen unos segundos (nadie contesta en 0 s)", async () => {
    const { w, agentId } = await voiceWorld({ allowBooking: true });
    const c = call(agentId);
    await handleCallEvent(dbs.app.db, { event: "call_started", call: c });
    // un cliente nuevo debe dar su nombre completo antes de agendar (lo exige la herramienta)
    expect((await runVoiceTool(dbs.app.db, { call: c, name: "guardar_datos_contacto", args: { nombre: "Ana Pérez Gómez" } }, { now: NOW })).ok).toBe(true);
    const args = { servicio_id: w.serviceId, empleado_id: w.staffId, inicio_iso: TUESDAY_10 };
    const t0 = new Date(NOW.getTime());
    expect((await runVoiceTool(dbs.app.db, { call: c, name: "crear_cita", args: { ...args, confirmado: false } }, { now: t0 })).requiere_confirmacion).toBe(true);
    expect((await runVoiceTool(dbs.app.db, { call: c, name: "crear_cita", args: { ...args, confirmado: true } }, { now: new Date(t0.getTime() + 500) })).error).toBe("falta_confirmacion");
    expect((await runVoiceTool(dbs.app.db, { call: c, name: "crear_cita", args: { ...args, confirmado: true } }, { now: new Date(t0.getTime() + 6000) })).ok).toBe(true);
  });

  it("escalar a una persona deja una escalada en la bandeja y un mensaje para decirle al cliente", async () => {
    const { w, agentId } = await voiceWorld();
    const c = call(agentId);
    await handleCallEvent(dbs.app.db, { event: "call_started", call: c });
    const r = await runVoiceTool(dbs.app.db, { call: c, name: "escalar_a_humano", args: { motivo: "Dolor fuerte de muela", urgencia: "alta" } }, { now: NOW });
    expect(typeof r.mensaje_para_el_cliente).toBe("string");
    const hs = await dbs.owner.db.select().from(handoffs).where(eq(handoffs.tenantId, w.tenantId));
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ reason: "Dolor fuerte de muela", urgency: "alta" });
  });

  it("no ejecuta funciones de una llamada que ya termino, de agentes desconocidos, ni con el servicio suspendido", async () => {
    const { w, agentId } = await voiceWorld();
    const c = call(agentId);
    await handleCallEvent(dbs.app.db, { event: "call_started", call: c });
    expect((await runVoiceTool(dbs.app.db, { call: call("agent_x"), name: "consultar_servicios", args: {} })).error).toBe("agente_desconocido");

    await dbs.owner.db.update(subscriptions).set({ status: "canceled" }).where(eq(subscriptions.tenantId, w.tenantId));
    expect((await runVoiceTool(dbs.app.db, { call: c, name: "consultar_servicios", args: {} }, { now: NOW })).error).toBe("servicio_no_disponible");
    await dbs.owner.db.update(subscriptions).set({ status: "comped" }).where(eq(subscriptions.tenantId, w.tenantId));

    await handleCallEvent(dbs.app.db, { event: "call_ended", call: { ...c, end_timestamp: NOW.getTime() + 1000 } });
    expect((await runVoiceTool(dbs.app.db, { call: c, name: "consultar_servicios", args: {} }, { now: NOW })).error).toBe("llamada_terminada");

    await dbs.owner.db.update(voiceSettings).set({ enabled: false }).where(eq(voiceSettings.tenantId, w.tenantId));
    expect((await runVoiceTool(dbs.app.db, { call: c, name: "consultar_servicios", args: {} }, { now: NOW })).error).toBe("agente_desconocido"); // desactivado: ya no se resuelve
  });
});

describe("transferir la llamada a una persona", () => {
  const withTransfer = async (humanHours?: Record<string, [string, string] | null>) => {
    const w = await world();
    if (humanHours) await dbs.owner.db.update(tenants).set({ humanHours }).where(eq(tenants.id, w.tenantId));
    await saveVoiceSettings(dbs.app.db, w.owner, { enabled: true, allowBooking: false, voiceId: "v1", transferNumber: "+529981110099" });
    const { client, calls: rc } = fakeRetell();
    const sync = await syncVoiceAgent(dbs.app.db, client, w.owner, { baseUrl: "https://panel.test" });
    if (!sync.ok) throw new Error("sync fallo");
    return { w, agentId: sync.agentId, rc };
  };

  it("sin numero de recepcion NO hay herramienta de transferencia ni se menciona en el prompt", async () => {
    const { retellCalls } = await voiceWorld();
    const llm = retellCalls.find((c) => c.path === "/create-retell-llm")!.body;
    expect(llm.general_tools.some((t: any) => t.type === "transfer_call" || t.name === "puede_transferir")).toBe(false);
    expect(llm.general_prompt).not.toContain("puede_transferir");
  });

  it("con numero: se crea la transferencia en FRIO (SIP REFER) a ese numero y la consulta de disponibilidad; el prompt exige consultarla antes", async () => {
    const { rc } = await withTransfer();
    const llm = rc.find((c) => c.path === "/create-retell-llm")!.body;
    const transfer = llm.general_tools.find((t: any) => t.type === "transfer_call");
    expect(transfer).toMatchObject({
      name: "transferir_a_persona",
      transfer_destination: { type: "predefined", number: "+529981110099" },
      transfer_option: { type: "cold_transfer", cold_transfer_mode: "sip_refer" },
    });
    expect(transfer.transfer_option.public_handoff_option).toBeUndefined();
    expect(llm.general_tools.find((t: any) => t.name === "puede_transferir")).toMatchObject({ type: "custom", url: "https://panel.test/api/voice/tools" });
    expect(llm.general_prompt).toContain("PRIMERO llama la herramienta puede_transferir");
    expect(llm.general_prompt).toContain("NO transfieras");
    expect(llm.general_prompt).toContain("NO la intentes otra vez");
    expect(llm.general_prompt).toContain("escalar_a_humano con tipo pidio_persona");
  });

  it("con telefonia propia en DIDWW el destino va como direccion SIP sin '+' (DIDWW rechaza el numero a secas); con otras lineas, el telefono", async () => {
    const dest = async (fake: ReturnType<typeof fakeRetell>, phoneNumber = "+529992829059") => {
      const w = await world();
      await saveVoiceSettings(dbs.app.db, w.owner, { enabled: true, allowBooking: false, voiceId: "v1", phoneNumber, transferNumber: "+529993518870" });
      const sync = await syncVoiceAgent(dbs.app.db, fake.client, w.owner, { baseUrl: "https://panel.test" });
      expect(sync.ok).toBe(true);
      const llm = fake.calls.find((c) => c.path === "/create-retell-llm")!.body;
      return llm.general_tools.find((t: any) => t.type === "transfer_call").transfer_destination;
    };
    // Linea de DIDWW: direccion SIP en el servidor de salida que el numero ya tiene en Retell.
    const didww = fakeRetell({ termination: "mia.us.out.didww.com" });
    expect(await dest(didww)).toEqual({ type: "predefined", number: "sip:529993518870@mia.us.out.didww.com" });
    expect(didww.calls.some((c) => c.method === "GET" && c.path === "/get-phone-number/%2B529992829059")).toBe(true);
    // Otra linea (Twilio): el telefono, como siempre.
    expect(await dest(fakeRetell({ termination: "mi-negocio.pstn.twilio.com" }))).toEqual({ type: "predefined", number: "+529993518870" });
    // Retell no encuentra el numero o falla: el telefono, y la sincronizacion no se cae.
    expect(await dest(fakeRetell({ phoneLookupFails: true }))).toEqual({ type: "predefined", number: "+529993518870" });
    // Sin numero de linea guardado no se consulta nada.
    const none = fakeRetell({ termination: "mia.us.out.didww.com" });
    expect(await dest(none, "")).toEqual({ type: "predefined", number: "+529993518870" });
    expect(none.calls.some((c) => c.path.startsWith("/get-phone-number/"))).toBe(false);
  });

  it("transferDestination: solo los servidores de salida de DIDWW cambian el formato", () => {
    expect(transferDestination("+529993518870", "mia.us.out.didww.com")).toBe("sip:529993518870@mia.us.out.didww.com");
    expect(transferDestination("+529993518870", "SIP:Fra.EU.out.didww.com:5060")).toBe("sip:529993518870@fra.eu.out.didww.com");
    expect(transferDestination("+529993518870", "any.out.didww.com")).toBe("sip:529993518870@any.out.didww.com");
    for (const other of ["out.didww.com", "mia.us.out.didww.com.evil.test", "evil-didww.com", "x.pstn.twilio.com", "", null, undefined])
      expect(transferDestination("+529993518870", other)).toBe("+529993518870");
  });

  it("el numero de recepcion debe ser internacional y solo lo guarda el dueño", async () => {
    const w = await world();
    const ok = { enabled: true, allowBooking: false, voiceId: "v", transferNumber: "9981110099" };
    expect(await saveVoiceSettings(dbs.app.db, w.owner, ok)).toMatchObject({ ok: false, error: "invalid" });
    expect(await saveVoiceSettings(dbs.app.db, w.agent, { ...ok, transferNumber: "+529981110099" })).toEqual({ ok: false, error: "forbidden" });
    expect(await saveVoiceSettings(dbs.app.db, w.owner, { ...ok, transferNumber: "+529981110099" })).toEqual({ ok: true });
    expect((await getVoiceSettings(dbs.app.db, w.owner, true)).transferNumber).toBe("+529981110099");
  });

  it("puede_transferir: SI dentro del horario humano; NO fuera de el (con cuando atienden) o sin horario configurado = siempre", async () => {
    // horario: todos los dias de 09:00 a 19:00 (hora de Merida). NOW = lunes 12:00 en Merida.
    const allDays = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, ["09:00", "19:00"] as [string, string]]));
    const open = await withTransfer(allDays);
    const c1 = call(open.agentId);
    await handleCallEvent(dbs.app.db, { event: "call_started", call: c1 });
    expect(await runVoiceTool(dbs.app.db, { call: c1, name: "puede_transferir", args: {} }, { now: NOW })).toMatchObject({ disponible: true });

    const night = new Date("2027-03-02T05:00:00Z"); // 23:00 del lunes en Merida: cerrado
    const r = await runVoiceTool(dbs.app.db, { call: c1, name: "puede_transferir", args: {} }, { now: night });
    expect(r).toMatchObject({ disponible: false, motivo: "fuera_de_horario" });
    expect(String(r.instruccion)).toContain("No transfieras");
    expect(String(r.instruccion)).toContain("escalar_a_humano");

    const noHours = await withTransfer();
    const c2 = call(noHours.agentId);
    await handleCallEvent(dbs.app.db, { event: "call_started", call: c2 });
    expect(await runVoiceTool(dbs.app.db, { call: c2, name: "puede_transferir", args: {} }, { now: night })).toMatchObject({ disponible: true });
  });

  it("sin numero configurado, puede_transferir no existe para el agente", async () => {
    const { agentId } = await voiceWorld();
    const c = call(agentId);
    await handleCallEvent(dbs.app.db, { event: "call_started", call: c });
    expect((await runVoiceTool(dbs.app.db, { call: c, name: "puede_transferir", args: {} }, { now: NOW })).error).toBe("herramienta_no_permitida");
  });
});
