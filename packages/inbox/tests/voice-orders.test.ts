import { contacts, conversations, menuCategories, menuItems, messages, orders, subscriptions, tenants } from "@empleado/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RetellClient, buildVoicePrompt, handleCallEvent, runVoiceTool, saveVoiceSettings, setOrderStatus, syncVoiceAgent, voiceToolNames, type RetellCall } from "../src";
import { NOW, dropWorld, makeWorld, openDbs, type Dbs, type World } from "./helpers";

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

function fakeRetell() {
  const calls: Array<{ path: string; body: any }> = [];
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (u.pathname === "/create-retell-llm") return json({ llm_id: `llm_${uid()}` });
    if (u.pathname === "/create-agent") return json({ agent_id: `agent_${uid()}` });
    return json({});
  }) as typeof fetch;
  return { client: new RetellClient({ apiKey: "key_test", baseUrl: "https://retell.test", fetch: fetchFake }), calls };
}

const PHONE = "+529981112233";

/** Un restaurante con voz activada, con o sin permiso para tomar pedidos, y su agente ya creado en Retell. */
async function voiceRestaurant(opts: { allowOrders: boolean; modules?: string[] }) {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  const db = dbs.owner.db;
  await db.insert(subscriptions).values({ tenantId: w.tenantId, status: "comped" });
  await db.update(tenants).set({ profile: { cancellationNoticeHours: 12, modules: opts.modules ?? ["restaurante"] } }).where(eq(tenants.id, w.tenantId));
  await db.update(contacts).set({ phoneE164: PHONE, displayName: "Laura" }).where(eq(contacts.id, w.contactId));
  const [cat] = await db.insert(menuCategories).values({ tenantId: w.tenantId, name: "Tacos" }).returning();
  const [pastor] = await db.insert(menuItems).values({ tenantId: w.tenantId, categoryId: cat!.id, name: "Pastor", priceCents: 1800 }).returning();
  expect(await saveVoiceSettings(dbs.app.db, w.owner, { enabled: true, allowBooking: false, allowOrders: opts.allowOrders, voiceId: "voz-es-mx", phoneNumber: "+529981110000" })).toEqual({ ok: true });
  const { client, calls } = fakeRetell();
  const sync = await syncVoiceAgent(dbs.app.db, client, w.owner, { baseUrl: "https://panel.test" });
  if (!sync.ok) throw new Error(`sync fallo: ${sync.error}`);
  return { w, agentId: sync.agentId, retellCalls: calls, pastor: pastor!.id };
}

const callOf = (agentId: string, from = PHONE): RetellCall => ({ call_id: `call_${uid()}`, agent_id: agentId, direction: "inbound", from_number: from, to_number: "+529981110000", start_timestamp: NOW.getTime() });
const turns = (c: RetellCall, n: number): RetellCall => ({ ...c, transcript_object: Array.from({ length: n }, () => ({ role: "user", content: "sí" })) });
const tool = (c: RetellCall, name: string, args: unknown, at = NOW) => runVoiceTool(dbs.app.db, { call: c, name, args }, { now: at }) as Promise<Record<string, any>>;

describe("prompt y herramientas de voz de un restaurante", () => {
  const base = (modules: string[]) => ({ tenant: { name: "Taquería Don Pepe", timezone: "America/Merida", profile: { modules }, slug: "x", vertical: "dental" } as never, config: { assistantName: "Sofi", tone: "cálido", formality: "tu", escalationRules: [], forbiddenTopics: [] } as never });

  it("con pedidos: menu hablado, confirmacion explicita, domicilio y alergias; sin citas ni urgencias dentales", () => {
    const p = buildVoicePrompt({ ...base(["restaurante"]), allowBooking: false, allowOrders: true });
    expect(p).toContain("MENÚ Y PEDIDOS POR TELÉFONO");
    expect(p).toContain("consultar_menu");
    expect(p).toContain("crear_pedido SIN confirmado");
    expect(p).toContain("¿Te lo confirmo?");
    expect(p).toContain("Repite la dirección completa");
    expect(p).toContain("Alergias");
    expect(p).not.toContain("AGENDAR");
    expect(p).not.toContain("Urgencias (dolor fuerte");
    expect(p).not.toContain("Sobre citas");
    expect(p).toContain("Platillos, precios, horarios y políticas");
  });

  it("sin permiso para pedidos: solo informa el menu y pasa los datos a una persona", () => {
    const p = buildVoicePrompt({ ...base(["restaurante"]), allowBooking: false, allowOrders: false });
    expect(p).toContain("los pedidos no se toman por teléfono");
    expect(p).toContain("escalar_a_humano");
    expect(p).not.toContain("crear_pedido SIN confirmado");
  });

  it("un negocio de citas queda como siempre (sin bloques de restaurante); con los dos modulos lleva ambos", () => {
    const citas = buildVoicePrompt({ ...base(["citas"]), allowBooking: true });
    expect(citas).toContain("AGENDAR POR TELÉFONO");
    expect(citas).toContain("Urgencias (dolor fuerte");
    expect(citas).not.toContain("MENÚ");
    const both = buildVoicePrompt({ ...base(["citas", "restaurante"]), allowBooking: true, allowOrders: true });
    expect(both).toContain("AGENDAR POR TELÉFONO");
    expect(both).toContain("MENÚ Y PEDIDOS POR TELÉFONO");
  });

  it("las herramientas de pedidos solo van si se permite; consultar_menu siempre", () => {
    expect(voiceToolNames(false)).toContain("consultar_menu");
    expect(voiceToolNames(false)).not.toContain("crear_pedido");
    expect(voiceToolNames(false, false, true)).toEqual(expect.arrayContaining(["crear_pedido", "estado_pedido", "cancelar_pedido"]));
  });

  it("al sincronizar, Retell recibe las funciones del restaurante (y no las de citas)", async () => {
    const on = await voiceRestaurant({ allowOrders: true });
    const names = (calls: typeof on.retellCalls) => (calls.find((c) => c.path === "/create-retell-llm")!.body.general_tools as Array<{ name: string }>).map((t) => t.name);
    expect(names(on.retellCalls)).toEqual(expect.arrayContaining(["consultar_menu", "crear_pedido", "estado_pedido", "cancelar_pedido", "end_call"]));
    expect(names(on.retellCalls)).not.toContain("crear_cita");
    const off = await voiceRestaurant({ allowOrders: false });
    expect(names(off.retellCalls)).toContain("consultar_menu");
    expect(names(off.retellCalls)).not.toContain("crear_pedido");
  });
});

describe("pedidos por llamada", () => {
  const order = (id: string, over: Record<string, unknown> = {}) => ({ articulos: [{ platillo_id: id, cantidad: 3 }], forma_de_pago: "efectivo", ...over });

  it("consulta el menu, propone, espera a que el cliente conteste y crea el pedido por el canal de voz con el telefono de quien llama", async () => {
    const { w, agentId, pastor } = await voiceRestaurant({ allowOrders: true });
    const c = callOf(agentId);
    await handleCallEvent(dbs.app.db, { event: "call_started", call: c });
    expect(await tool(c, "consultar_menu", { busqueda: "pastor" })).toMatchObject({ resultados: [{ nombre: "Pastor", precio: "$18 MXN" }] });

    const t0 = new Date(NOW.getTime());
    const proposal = await tool(turns(c, 1), "crear_pedido", order(pastor), t0);
    expect(proposal.requiere_confirmacion).toBe(true);
    expect(proposal.resumen).toContain("$54 MXN");
    expect(await dbs.owner.db.select().from(orders).where(eq(orders.tenantId, w.tenantId))).toHaveLength(0);

    // El modelo insiste en el mismo turno: no se crea.
    expect((await tool(turns(c, 1), "crear_pedido", { ...order(pastor), confirmado: true }, new Date(t0.getTime() + 2000))).error).toBe("falta_confirmacion");

    const done = await tool(turns(c, 2), "crear_pedido", { ...order(pastor), confirmado: true }, new Date(t0.getTime() + 9000));
    expect(done).toMatchObject({ ok: true, pedido_numero: 1, total: "$54 MXN" });
    const [o] = await dbs.owner.db.select().from(orders).where(eq(orders.tenantId, w.tenantId));
    expect(o).toMatchObject({ channel: "voice", customerName: "Laura", customerPhone: PHONE, totalCents: 5400, status: "new" });

    // Y puede preguntar por su pedido durante la misma llamada.
    expect((await tool(turns(c, 2), "estado_pedido", {}, new Date(t0.getTime() + 12000))).pedidos[0]).toMatchObject({ pedido_numero: 1, total: "$54 MXN" });
  });

  it("sin permiso para pedidos, crear_pedido se rechaza por teléfono (pero el menu se consulta)", async () => {
    const { w, agentId, pastor } = await voiceRestaurant({ allowOrders: false });
    const c = callOf(agentId);
    await handleCallEvent(dbs.app.db, { event: "call_started", call: c });
    expect((await tool(c, "crear_pedido", order(pastor, { confirmado: true }))).error).toBe("herramienta_no_permitida");
    expect(await tool(c, "consultar_menu", {})).toMatchObject({ categorias: [{ nombre: "Tacos" }] });
    expect(await dbs.owner.db.select().from(orders).where(eq(orders.tenantId, w.tenantId))).toHaveLength(0);
  });

  it("con numero oculto pide el telefono antes de crear el pedido", async () => {
    const { agentId, pastor } = await voiceRestaurant({ allowOrders: true });
    const c = callOf(agentId, "");
    await handleCallEvent(dbs.app.db, { event: "call_started", call: c });
    expect((await tool(c, "guardar_datos_contacto", { nombre: "Carlos Ruiz" })).ok).toBe(true);
    expect(await tool(c, "crear_pedido", order(pastor))).toMatchObject({ error: "faltan_datos", faltan: ["teléfono a 10 dígitos"] });
  });

  it("el aviso de «listo» de un pedido por llamada llega por WhatsApp si su ventana sigue abierta; si no, se avisa que no se pudo", async () => {
    const { w, agentId, pastor } = await voiceRestaurant({ allowOrders: true });
    const c = callOf(agentId);
    await handleCallEvent(dbs.app.db, { event: "call_started", call: c });
    const t0 = new Date(NOW.getTime());
    await tool(turns(c, 1), "crear_pedido", order(pastor), t0);
    await tool(turns(c, 2), "crear_pedido", { ...order(pastor), confirmado: true }, new Date(t0.getTime() + 9000));
    const [o] = await dbs.owner.db.select().from(orders).where(eq(orders.tenantId, w.tenantId));
    expect(o!.conversationId).not.toBe(w.conversationId); // la conversacion del pedido es la de voz

    const jobs: string[] = [];
    const enqueue = async (j: { messageId: string }) => void jobs.push(j.messageId);
    const sent = await setOrderStatus(dbs.app.db, w.owner, o!.id, "ready", {}, enqueue, NOW);
    expect(sent).toMatchObject({ ok: true, notice: "sent" });
    const [m] = await dbs.owner.db.select().from(messages).where(eq(messages.id, jobs[0]!));
    expect(m!.conversationId).toBe(w.conversationId); // salio por la conversacion de WhatsApp, no por la de voz
    expect(m!.body).toContain("listo para recoger");

    // Sin ventana abierta en WhatsApp, no hay por donde escribirle.
    await dbs.owner.db.update(conversations).set({ lastInboundAt: new Date(NOW.getTime() - 40 * 3_600_000) }).where(eq(conversations.id, w.conversationId));
    const second = await dbs.owner.db.insert(orders).values({ ...o!, id: undefined as never, number: 2, status: "new", idempotencyKey: null, notifiedAt: null }).returning();
    const late = await setOrderStatus(dbs.app.db, w.owner, second[0]!.id, "ready", {}, enqueue, NOW);
    expect(late).toMatchObject({ ok: true, notice: "voice" });
  });
});
