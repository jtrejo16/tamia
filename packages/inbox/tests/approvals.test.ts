import { appointments, auditLog, channels, conversations, messages } from "@empleado/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  approveDraft,
  discardDraft,
  listAppointments,
  listApprovals,
  runPlaygroundTurn,
  setAppointmentStatus,
  takeControl,
} from "../src";
import {
  FakeLLM,
  NOW,
  TUESDAY_10,
  addApproval,
  addMessage,
  bookingAction,
  dropWorld,
  makeWorld,
  openDbs,
  type Dbs,
  type World,
} from "./helpers";

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
  const w = await makeWorld(dbs.owner, { autonomy: "copilot", ...options });
  worlds.push(w);
  return w;
}
const approve = (w: World, id: string, text?: string, enqueue = vi.fn().mockResolvedValue(undefined)) =>
  approveDraft(dbs.app.db, w.agent, id, { text, now: NOW }, enqueue);
const appts = (w: World) => dbs.owner.db.select().from(appointments).where(eq(appointments.tenantId, w.tenantId));
const outbound = (w: World) =>
  dbs.owner.db.select().from(messages).where(and(eq(messages.conversationId, w.conversationId), eq(messages.direction, "out")));

describe("borradores por aprobar", () => {
  it("lista los pendientes con el contexto de la conversacion", async () => {
    const w = await world();
    await addMessage(dbs.owner, w, { direction: "in", body: "¿Tienen lugar el martes?", createdAt: new Date(NOW.getTime() - 5000) });
    const draft = await addApproval(dbs.owner, w, "Sí, tengo 10:00 con la Dra. Ruiz.", [bookingAction(w)]);
    const [item] = await listApprovals(dbs.app.db, w.agent, { now: NOW });
    expect(item).toMatchObject({ id: draft.id, draft: "Sí, tengo 10:00 con la Dra. Ruiz.", status: "pending" });
    expect(item!.actions[0]!.summary).toContain("Limpieza dental");
    expect(item!.contact.name).toBe("Carlos Pérez");
    expect(item!.conversation.windowOpen).toBe(true);
    expect(item!.context.map((m) => m.text)).toContain("¿Tienen lugar el martes?");
  });

  it("aprobar tal cual: el mensaje sale como del asistente y queda en cola de envio", async () => {
    const w = await world();
    const draft = await addApproval(dbs.owner, w, "Con gusto, le ayudo.");
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const r = await approve(w, draft.id, undefined, enqueue);

    expect(r).toMatchObject({ ok: true, edited: false, executed: [] });
    const [msg] = await outbound(w);
    expect(msg).toMatchObject({ sender: "bot", status: "queued", body: "Con gusto, le ayudo." });
    expect(enqueue).toHaveBeenCalledWith({ tenantId: w.tenantId, messageId: msg!.id });
    const reviewed = await listApprovals(dbs.app.db, w.agent, { status: "reviewed", now: NOW });
    expect(reviewed.map((a) => a.status)).toEqual(["approved"]);
  });

  it("aprobar EDITADO: sale como de una persona y se guarda el par borrador -> version final", async () => {
    const w = await world();
    const draft = await addApproval(dbs.owner, w, "Hola, la limpieza cuesta 600 pesos.");
    const r = await approve(w, draft.id, "Hola Carlos, la limpieza cuesta $600 MXN y dura 45 minutos.");
    expect(r).toMatchObject({ ok: true, edited: true });
    const [msg] = await outbound(w);
    expect(msg).toMatchObject({ sender: "human", body: "Hola Carlos, la limpieza cuesta $600 MXN y dura 45 minutos." });
    const { approvals } = await import("@empleado/db");
    const [row] = await dbs.owner.db.select().from(approvals).where(eq(approvals.id, draft.id));
    expect(row).toMatchObject({
      status: "edited",
      draft: "Hola, la limpieza cuesta 600 pesos.",
      finalText: "Hola Carlos, la limpieza cuesta $600 MXN y dura 45 minutos.",
      reviewedBy: w.agentId,
    });
  });

  it("al aprobar se EJECUTA la cita que el asistente propuso", async () => {
    const w = await world();
    const draft = await addApproval(dbs.owner, w, "Listo, su cita quedó para el martes a las 10.", [bookingAction(w)]);
    const r = await approve(w, draft.id);

    expect(r).toMatchObject({ ok: true, executed: ["crear_cita"] });
    const rows = await appts(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "confirmed", contactId: w.contactId });
    expect(rows[0]!.startsAt.toISOString()).toBe(TUESDAY_10);
    const log = await dbs.owner.db.select().from(auditLog).where(and(eq(auditLog.tenantId, w.tenantId), eq(auditLog.action, "appointment.created")));
    expect(log[0]!.diff).toMatchObject({ actor: "bot_aprobado_por_humano" });
    expect(await outbound(w)).toHaveLength(1);
  });

  it("si la cita ya no se puede hacer, NO se envia nada y el borrador sigue pendiente", async () => {
    const w = await world();
    // Alguien se quedo con ese horario mientras el borrador esperaba.
    await dbs.owner.db.insert(appointments).values({
      tenantId: w.tenantId, contactId: w.contactId, serviceId: w.serviceId, staffId: w.staffId,
      startsAt: new Date(TUESDAY_10), endsAt: new Date("2027-03-02T16:45:00Z"), status: "confirmed",
    });
    const draft = await addApproval(dbs.owner, w, "Listo, quedó agendada.", [bookingAction(w)]);
    const enqueue = vi.fn();
    const r = await approve(w, draft.id, undefined, enqueue);

    expect(r).toMatchObject({ ok: false, error: "actions_failed" });
    expect((r as { details?: string[] }).details?.[0]).toContain("crear_cita");
    expect(await outbound(w)).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await appts(w)).toHaveLength(1); // solo la que ya existia
    expect((await listApprovals(dbs.app.db, w.agent, { now: NOW })).map((a) => a.id)).toEqual([draft.id]); // sigue pendiente
  });

  it("aprobar dos veces (doble clic) envia UN solo mensaje", async () => {
    const w = await world();
    const draft = await addApproval(dbs.owner, w, "Hola");
    const results = await Promise.all([approve(w, draft.id), approve(w, draft.id)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ error: "already_reviewed" });
    expect(await outbound(w)).toHaveLength(1);
  });

  it("no se aprueba si una persona ya tomo el control (el borrador se descartó), ni fuera de la ventana", async () => {
    const w = await world();
    const draft = await addApproval(dbs.owner, w, "Hola");
    await takeControl(dbs.app.db, w.owner, w.conversationId);
    expect(await approve(w, draft.id)).toMatchObject({ ok: false, error: "already_reviewed" }); // descartado al tomar el control

    const w2 = await world();
    const d2 = await addApproval(dbs.owner, w2, "Hola");
    await dbs.owner.db.update(conversations).set({ state: "human" }).where(eq(conversations.id, w2.conversationId));
    expect(await approve(w2, d2.id)).toMatchObject({ ok: false, error: "conversation_in_human_control" });

    const w3 = await world({ lastInboundAt: new Date(NOW.getTime() - 30 * 3600_000) });
    const d3 = await addApproval(dbs.owner, w3, "Hola");
    expect(await approve(w3, d3.id)).toMatchObject({ ok: false, error: "window_closed" });
  });

  it("valida el texto editado y los permisos", async () => {
    const w = await world();
    const draft = await addApproval(dbs.owner, w, "Hola");
    expect(await approve(w, draft.id, "   ")).toMatchObject({ error: "empty" });
    expect(await approve(w, draft.id, "x".repeat(3801))).toMatchObject({ error: "too_long" });
    expect(await approveDraft(dbs.app.db, w.viewer, draft.id, { now: NOW }, vi.fn())).toMatchObject({ error: "forbidden" });
    expect(await outbound(w)).toHaveLength(0);
  });

  it("descartar un borrador no envia nada", async () => {
    const w = await world();
    const draft = await addApproval(dbs.owner, w, "No lo envies");
    expect(await discardDraft(dbs.app.db, w.agent, draft.id)).toEqual({ ok: true });
    expect(await discardDraft(dbs.app.db, w.agent, draft.id)).toEqual({ ok: false, error: "already_reviewed" });
    expect(await outbound(w)).toHaveLength(0);
    expect(await discardDraft(dbs.app.db, w.viewer, draft.id)).toEqual({ ok: false, error: "forbidden" });
  });

  it("un negocio no puede aprobar ni descartar los borradores de otro", async () => {
    const a = await world();
    const b = await world();
    const draft = await addApproval(dbs.owner, a, "Privado de A");
    expect(await listApprovals(dbs.app.db, b.owner, { now: NOW })).toHaveLength(0);
    expect(await approveDraft(dbs.app.db, b.owner, draft.id, { now: NOW }, vi.fn())).toMatchObject({ error: "not_found" });
    expect(await discardDraft(dbs.app.db, b.owner, draft.id)).toEqual({ ok: false, error: "not_found" });
    expect(await outbound(a)).toHaveLength(0);
  });
});

describe("citas en el panel", () => {
  async function bookedWorld() {
    const w = await world();
    const [a] = await dbs.owner.db
      .insert(appointments)
      .values({
        tenantId: w.tenantId, contactId: w.contactId, serviceId: w.serviceId, staffId: w.staffId,
        startsAt: new Date(TUESDAY_10), endsAt: new Date("2027-03-02T16:45:00Z"), status: "confirmed",
      })
      .returning();
    return { w, appt: a! };
  }

  it("lista las citas proximas con servicio, especialista y cliente", async () => {
    const { w } = await bookedWorld();
    const [item] = await listAppointments(dbs.app.db, w.viewer, { now: NOW });
    expect(item).toMatchObject({ status: "confirmed", service: { name: "Limpieza dental" }, staff: { name: "Dra. Ruiz" } });
    expect(item!.contact.name).toBe("Carlos Pérez");
  });

  it("las canceladas no salen salvo que se pidan, y no se ven las de otro negocio", async () => {
    const { w, appt } = await bookedWorld();
    await setAppointmentStatus(dbs.app.db, w.agent, appt.id, "cancelled");
    expect(await listAppointments(dbs.app.db, w.agent, { now: NOW })).toHaveLength(0);
    expect(await listAppointments(dbs.app.db, w.agent, { now: NOW, includeInactive: true })).toHaveLength(1);
    const other = await world();
    expect(await listAppointments(dbs.app.db, other.owner, { now: NOW, includeInactive: true })).toHaveLength(0);
  });

  it("cambia el estado con auditoria y solo por transiciones validas", async () => {
    const { w, appt } = await bookedWorld();
    expect(await setAppointmentStatus(dbs.app.db, w.agent, appt.id, "done")).toEqual({ ok: true, status: "done" });
    expect(await setAppointmentStatus(dbs.app.db, w.agent, appt.id, "confirmed")).toEqual({ ok: false, error: "invalid_transition" });
    const log = await dbs.owner.db.select().from(auditLog).where(and(eq(auditLog.tenantId, w.tenantId), eq(auditLog.action, "appointment.done")));
    expect(log[0]).toMatchObject({ userId: w.agentId });
    expect(log[0]!.diff).toMatchObject({ from: "confirmed", to: "done", actor: "panel" });
  });

  it("un lector no puede cambiar citas y otro negocio tampoco", async () => {
    const { w, appt } = await bookedWorld();
    expect(await setAppointmentStatus(dbs.app.db, w.viewer, appt.id, "cancelled")).toEqual({ ok: false, error: "forbidden" });
    const other = await world();
    expect(await setAppointmentStatus(dbs.app.db, other.owner, appt.id, "cancelled")).toEqual({ ok: false, error: "not_found" });
  });
});

describe("probador del panel", () => {
  it("conversa con el agente real sin enviar nada a WhatsApp y sin aparecer en la bandeja", async () => {
    const w = await world({ autonomy: "auto" });
    const llm = new FakeLLM(["¡Hola! Soy Sonri.", "La limpieza cuesta $600 MXN."]);
    const first = await runPlaygroundTurn(dbs.app.db, llm, w.owner, { text: "Hola", sessionKey: "sesion-de-prueba-1", now: NOW });
    expect(first).toMatchObject({ ok: true, turn: { action: "send", text: "¡Hola! Soy Sonri." } });

    const second = await runPlaygroundTurn(dbs.app.db, llm, w.owner, { text: "¿Cuánto cuesta?", sessionKey: "sesion-de-prueba-1", now: NOW });
    expect(second.ok && second.turn.conversationId).toBe(first.ok && first.turn.conversationId); // misma conversacion
    // El segundo turno ya "ve" la primera respuesta (memoria de la conversacion).
    expect(JSON.stringify(llm.requests[1]!.messages)).toContain("¡Hola! Soy Sonri.");

    // Nada quedo "en cola" para enviarse a nadie.
    const queued = await dbs.owner.db.select().from(messages).where(and(eq(messages.tenantId, w.tenantId), eq(messages.status, "queued")));
    expect(queued).toHaveLength(0);
    // Y no se mezcla con las conversaciones reales.
    const { listConversations } = await import("../src");
    expect((await listConversations(dbs.app.db, w.owner, { now: NOW })).map((c) => c.id)).toEqual([w.conversationId]);
    const pgChannels = await dbs.owner.db.select().from(channels).where(and(eq(channels.tenantId, w.tenantId), eq(channels.type, "playground")));
    expect(pgChannels).toHaveLength(1);
  });

  it("otra clave de sesion empieza una conversacion nueva", async () => {
    const w = await world({ autonomy: "auto" });
    const llm = new FakeLLM();
    const a = await runPlaygroundTurn(dbs.app.db, llm, w.owner, { text: "Hola", sessionKey: "sesion-numero-A1", now: NOW });
    const b = await runPlaygroundTurn(dbs.app.db, llm, w.owner, { text: "Hola", sessionKey: "sesion-numero-B2", now: NOW });
    expect(a.ok && b.ok && a.turn.conversationId !== b.turn.conversationId).toBe(true);
  });

  it("respeta el nivel de autonomia: en copiloto el resultado es un borrador, que no aparece en aprobaciones", async () => {
    const w = await world({ autonomy: "copilot" });
    const r = await runPlaygroundTurn(dbs.app.db, new FakeLLM(), w.owner, { text: "Hola", sessionKey: "sesion-copiloto-1", now: NOW });
    expect(r.ok && r.turn.action).toBe("draft");
    expect(await listApprovals(dbs.app.db, w.owner, { now: NOW })).toHaveLength(0);
  });

  it("valida la entrada y los permisos", async () => {
    const w = await world();
    const llm = new FakeLLM();
    expect(await runPlaygroundTurn(dbs.app.db, llm, w.viewer, { text: "Hola", sessionKey: "sesion-valida-1" })).toEqual({ ok: false, error: "forbidden" });
    expect(await runPlaygroundTurn(dbs.app.db, llm, w.owner, { text: "  ", sessionKey: "sesion-valida-1" })).toEqual({ ok: false, error: "empty" });
    expect(await runPlaygroundTurn(dbs.app.db, llm, w.owner, { text: "Hola", sessionKey: "../../etc" })).toEqual({ ok: false, error: "bad_session" });
    expect(llm.requests).toHaveLength(0);
  });
});
