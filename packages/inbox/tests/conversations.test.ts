import { approvals, auditLog, channels, conversations, handoffs, memberships, messages, tenants } from "@empleado/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authenticate,
  closeConversation,
  getConversation,
  listConversations,
  releaseControl,
  sendHumanMessage,
  takeControl,
} from "../src";
import { NOW, PASSWORD, addApproval, addMessage, dropWorld, makeWorld, openDbs, type Dbs, type World } from "./helpers";

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

async function world(options?: Parameters<typeof makeWorld>[1]) {
  const w = await makeWorld(dbs.owner, options);
  worlds.push(w);
  return w;
}

describe("inicio de sesion", () => {
  it("entra con correo y contraseña correctos y devuelve negocio y rol", async () => {
    const w = await world();
    const r = await authenticate(dbs.app.db, w.ownerEmail, PASSWORD);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.login).toMatchObject({ userId: w.ownerId, tenantId: w.tenantId, tenantName: "Clínica Panel", role: "owner", userName: "dueno de prueba" });
    }
  });

  it("no distingue mayusculas en el correo", async () => {
    const w = await world();
    expect((await authenticate(dbs.app.db, w.ownerEmail.toUpperCase(), PASSWORD)).ok).toBe(true);
  });

  it("contraseña incorrecta, correo inexistente y usuario sin contraseña responden igual", async () => {
    const w = await world();
    const noPassword = await world({ withPassword: false });
    const bad = await authenticate(dbs.app.db, w.ownerEmail, "otra-contraseña-larga");
    const unknown = await authenticate(dbs.app.db, "nadie@no-existe.test", PASSWORD);
    const empty = await authenticate(dbs.app.db, noPassword.ownerEmail, PASSWORD);
    for (const r of [bad, unknown, empty]) expect(r).toEqual({ ok: false, error: "invalid_credentials" });
  });

  it("un usuario sin membresia no entra, y un negocio pausado tampoco", async () => {
    const w = await world();
    await dbs.owner.db.delete(memberships).where(eq(memberships.userId, w.viewerId));
    expect(await authenticate(dbs.app.db, (await getEmail(w.viewerId)), PASSWORD)).toEqual({ ok: false, error: "no_membership" });

    await dbs.owner.db.update(tenants).set({ status: "paused" }).where(eq(tenants.id, w.tenantId));
    expect(await authenticate(dbs.app.db, w.ownerEmail, PASSWORD)).toEqual({ ok: false, error: "tenant_inactive" });
  });

  it("con varios negocios entra al de mayor rol", async () => {
    const a = await world();
    const b = await world();
    await dbs.owner.db.insert(memberships).values({ tenantId: b.tenantId, userId: a.ownerId, role: "viewer" });
    const r = await authenticate(dbs.app.db, a.ownerEmail, PASSWORD);
    expect(r.ok && r.login.tenantId).toBe(a.tenantId);
    expect(r.ok && r.login.role).toBe("owner");
  });
});

async function getEmail(userId: string): Promise<string> {
  const { users } = await import("@empleado/db");
  const [u] = await dbs.owner.db.select().from(users).where(eq(users.id, userId));
  return u!.email;
}

describe("bandeja", () => {
  it("lista la conversacion con el nombre del cliente, vista previa y estado de la ventana de 24 h", async () => {
    const w = await world();
    await addMessage(dbs.owner, w, { direction: "in", body: "Hola, ¿tienen lugar mañana?", createdAt: new Date(NOW.getTime() - 60_000) });
    const [item] = await listConversations(dbs.app.db, w.agent, { now: NOW });
    expect(item).toMatchObject({
      id: w.conversationId,
      state: "bot",
      preview: "Hola, ¿tienen lugar mañana?",
      previewFromCustomer: true,
      windowOpen: true,
      pendingApprovals: 0,
      needsAttention: false,
    });
    expect(item!.contact).toMatchObject({ name: "Carlos Pérez", hasRealName: true, whatsappName: "Carlitos" });
    expect(item!.windowClosesAt?.toISOString()).toBe("2027-03-02T18:00:00.000Z");
  });

  it("sin nombre real muestra el apodo de WhatsApp; la ventana se cierra a las 24 h", async () => {
    const w = await world();
    await dbs.owner.db.execute((await import("drizzle-orm")).sql`update contacts set display_name = null where id = ${w.contactId}`);
    const [item] = await listConversations(dbs.app.db, w.owner, { now: new Date(NOW.getTime() + 25 * 3600_000) });
    expect(item!.contact.name).toBe("Carlitos");
    expect(item!.contact.hasRealName).toBe(false);
    expect(item!.windowOpen).toBe(false);
  });

  it("la vista previa de una nota de voz usa la transcripcion", async () => {
    const w = await world();
    await addMessage(dbs.owner, w, { direction: "in", type: "audio", body: "", transcript: "quiero una cita el jueves" });
    const [item] = await listConversations(dbs.app.db, w.owner, { now: NOW });
    expect(item!.preview).toContain("quiero una cita el jueves");
  });

  it("marca 'requiere atencion' si hay borrador por aprobar o escalada, y el filtro lo respeta", async () => {
    const w = await world();
    expect((await listConversations(dbs.app.db, w.owner, { filter: "attention", now: NOW })).length).toBe(0);

    await addApproval(dbs.owner, w, "Borrador");
    const [pending] = await listConversations(dbs.app.db, w.owner, { filter: "attention", now: NOW });
    expect(pending).toMatchObject({ pendingApprovals: 1, needsAttention: true });

    await dbs.owner.db.insert(handoffs).values({ tenantId: w.tenantId, conversationId: w.conversationId, reason: "Dolor fuerte", urgency: "alta" });
    const [escalated] = await listConversations(dbs.app.db, w.owner, { now: NOW });
    expect(escalated!.handoff).toEqual({ urgency: "alta", reason: "Dolor fuerte" });
  });

  it("busca por nombre, apodo o telefono", async () => {
    const w = await world();
    for (const q of ["Carlos", "carlitos", "198"]) {
      expect((await listConversations(dbs.app.db, w.owner, { search: q, now: NOW })).length).toBe(1);
    }
    expect((await listConversations(dbs.app.db, w.owner, { search: "zzz-nadie", now: NOW })).length).toBe(0);
  });

  it("NO muestra las conversaciones del probador", async () => {
    const w = await world();
    const [pg] = await dbs.owner.db.insert(channels).values({ tenantId: w.tenantId, type: "playground", externalId: `pg-${w.tenantId}` }).returning();
    await dbs.owner.db.insert(conversations).values({ tenantId: w.tenantId, contactId: w.contactId, channelId: pg!.id });
    const list = await listConversations(dbs.app.db, w.owner, { now: NOW });
    expect(list.map((c) => c.id)).toEqual([w.conversationId]);
  });

  it("el detalle trae los mensajes en orden, con ubicaciones legibles", async () => {
    const w = await world();
    await addMessage(dbs.owner, w, { direction: "in", body: "Hola", createdAt: new Date(NOW.getTime() - 3000) });
    await addMessage(dbs.owner, w, { direction: "out", body: "¡Hola! Soy Sonri.", createdAt: new Date(NOW.getTime() - 2000) });
    await addMessage(dbs.owner, w, { direction: "out", type: "location", body: JSON.stringify({ name: "Clínica", address: "Calle 60" }), createdAt: new Date(NOW.getTime() - 1000) });
    const detail = await getConversation(dbs.app.db, w.agent, w.conversationId, { now: NOW });
    expect(detail!.messages.map((m) => m.text)).toEqual(["Hola", "¡Hola! Soy Sonri.", "📍 Ubicación: Clínica · Calle 60"]);
    expect(detail!.messages.map((m) => m.direction)).toEqual(["in", "out", "out"]);
  });

  it("un negocio NO ve ni toca las conversaciones de otro", async () => {
    const a = await world();
    const b = await world();
    expect(await listConversations(dbs.app.db, b.owner, { now: NOW })).toHaveLength(1); // solo la suya
    expect(await getConversation(dbs.app.db, b.owner, a.conversationId, { now: NOW })).toBeNull();
    expect(await takeControl(dbs.app.db, b.owner, a.conversationId)).toEqual({ ok: false, error: "not_found" });
    expect(await closeConversation(dbs.app.db, b.owner, a.conversationId)).toEqual({ ok: false, error: "not_found" });
    const send = await sendHumanMessage(dbs.app.db, b.owner, a.conversationId, "intruso", vi.fn(), NOW);
    expect(send).toEqual({ ok: false, error: "not_found" });
  });
});

describe("tomar el control", () => {
  it("pausa al asistente, asigna a la persona, toma la escalada y descarta borradores pendientes", async () => {
    const w = await world();
    await dbs.owner.db.insert(handoffs).values({ tenantId: w.tenantId, conversationId: w.conversationId, reason: "Queja", urgency: "normal" });
    const draft = await addApproval(dbs.owner, w, "Borrador viejo");

    expect(await takeControl(dbs.app.db, w.agent, w.conversationId)).toEqual({ ok: true, state: "human" });

    const [conv] = await dbs.owner.db.select().from(conversations).where(eq(conversations.id, w.conversationId));
    expect(conv).toMatchObject({ state: "human", assignedUserId: w.agentId });
    const [h] = await dbs.owner.db.select().from(handoffs).where(eq(handoffs.conversationId, w.conversationId));
    expect(h!.takenBy).toBe(w.agentId);
    const [a] = await dbs.owner.db.select().from(approvals).where(eq(approvals.id, draft.id));
    expect(a!.status).toBe("discarded");
    const log = await dbs.owner.db.select().from(auditLog).where(and(eq(auditLog.tenantId, w.tenantId), eq(auditLog.action, "conversation.take_control")));
    expect(log).toHaveLength(1);
    expect(log[0]!.userId).toBe(w.agentId);
  });

  it("devolver al asistente resuelve la escalada y libera la asignacion", async () => {
    const w = await world();
    await dbs.owner.db.insert(handoffs).values({ tenantId: w.tenantId, conversationId: w.conversationId, reason: "Queja", urgency: "normal" });
    await takeControl(dbs.app.db, w.agent, w.conversationId);
    expect(await releaseControl(dbs.app.db, w.agent, w.conversationId)).toEqual({ ok: true, state: "bot" });
    const [conv] = await dbs.owner.db.select().from(conversations).where(eq(conversations.id, w.conversationId));
    expect(conv).toMatchObject({ state: "bot", assignedUserId: null });
    const [h] = await dbs.owner.db.select().from(handoffs).where(eq(handoffs.conversationId, w.conversationId));
    expect(h!.resolvedAt).toBeTruthy();
  });

  it("cerrar la conversacion la deja cerrada y no se puede tomar de nuevo", async () => {
    const w = await world();
    expect(await closeConversation(dbs.app.db, w.owner, w.conversationId)).toEqual({ ok: true, state: "closed" });
    expect(await takeControl(dbs.app.db, w.owner, w.conversationId)).toEqual({ ok: false, error: "conversation_closed" });
  });

  it("un lector (viewer) puede mirar pero no actuar", async () => {
    const w = await world();
    expect((await listConversations(dbs.app.db, w.viewer, { now: NOW })).length).toBe(1);
    expect(await takeControl(dbs.app.db, w.viewer, w.conversationId)).toEqual({ ok: false, error: "forbidden" });
    expect(await releaseControl(dbs.app.db, w.viewer, w.conversationId)).toEqual({ ok: false, error: "forbidden" });
    expect(await closeConversation(dbs.app.db, w.viewer, w.conversationId)).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("responder como persona", () => {
  it("solo se puede responder con el control tomado; el mensaje queda en cola y se encola su envio", async () => {
    const w = await world();
    const enqueue = vi.fn().mockResolvedValue(undefined);

    expect(await sendHumanMessage(dbs.app.db, w.agent, w.conversationId, "Hola", enqueue, NOW)).toEqual({ ok: false, error: "not_in_control" });
    expect(enqueue).not.toHaveBeenCalled();

    await takeControl(dbs.app.db, w.agent, w.conversationId);
    const r = await sendHumanMessage(dbs.app.db, w.agent, w.conversationId, "  Hola Carlos, soy Ana de recepción  ", enqueue, NOW);
    expect(r.ok).toBe(true);
    const [msg] = await dbs.owner.db.select().from(messages).where(and(eq(messages.conversationId, w.conversationId), eq(messages.direction, "out")));
    expect(msg).toMatchObject({ sender: "human", status: "queued", body: "Hola Carlos, soy Ana de recepción", type: "text" });
    expect(enqueue).toHaveBeenCalledWith({ tenantId: w.tenantId, messageId: msg!.id });
  });

  it("si otra persona tiene el control, no se puede responder en su lugar", async () => {
    const w = await world();
    await takeControl(dbs.app.db, w.agent, w.conversationId);
    const r = await sendHumanMessage(dbs.app.db, w.owner, w.conversationId, "Yo contesto", vi.fn(), NOW);
    expect(r).toEqual({ ok: false, error: "not_in_control" });
  });

  it("fuera de la ventana de 24 h NO deja enviar texto libre", async () => {
    const w = await world();
    await takeControl(dbs.app.db, w.agent, w.conversationId);
    const r = await sendHumanMessage(dbs.app.db, w.agent, w.conversationId, "Hola", vi.fn(), new Date(NOW.getTime() + 25 * 3600_000));
    expect(r).toEqual({ ok: false, error: "window_closed" });
  });

  it("valida el texto y los permisos", async () => {
    const w = await world();
    await takeControl(dbs.app.db, w.agent, w.conversationId);
    expect(await sendHumanMessage(dbs.app.db, w.agent, w.conversationId, "   ", vi.fn(), NOW)).toEqual({ ok: false, error: "empty" });
    expect(await sendHumanMessage(dbs.app.db, w.agent, w.conversationId, "x".repeat(3801), vi.fn(), NOW)).toEqual({ ok: false, error: "too_long" });
    expect(await sendHumanMessage(dbs.app.db, w.viewer, w.conversationId, "Hola", vi.fn(), NOW)).toEqual({ ok: false, error: "forbidden" });
  });

  it("si la cola falla, el mensaje queda guardado en cola para que el barrido lo envie", async () => {
    const w = await world();
    await takeControl(dbs.app.db, w.agent, w.conversationId);
    const r = await sendHumanMessage(dbs.app.db, w.agent, w.conversationId, "Hola", vi.fn().mockRejectedValue(new Error("redis caido")), NOW);
    expect(r.ok).toBe(true);
    const [msg] = await dbs.owner.db.select().from(messages).where(and(eq(messages.conversationId, w.conversationId), eq(messages.direction, "out")));
    expect(msg!.status).toBe("queued");
  });
});
