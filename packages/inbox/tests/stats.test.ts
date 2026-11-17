import { appointments, approvals, calls, handoffs, messages, usageEvents } from "@empleado/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getStats } from "../src";
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

const D = 86_400_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const MIN = 60_000;

async function msg(w: World, m: { dir: "in" | "out"; sender?: "contact" | "bot" | "human"; at: Date; status?: any; type?: any }) {
  await dbs.owner.db.insert(messages).values({
    tenantId: w.tenantId,
    conversationId: w.conversationId,
    channelId: w.channelId,
    direction: m.dir,
    sender: m.sender ?? (m.dir === "in" ? "contact" : "bot"),
    type: m.type ?? "text",
    body: "x",
    status: m.status ?? (m.dir === "in" ? "received" : "sent"),
    createdAt: m.at,
  });
}

/** Un negocio con actividad conocida; las cifras esperadas se calcularon a mano. */
async function busyWorld() {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  const base = -1 * D + 10 * 3600_000 - 18 * 3600_000; // ayer 10:00 UTC aprox (NOW es 18:00 UTC)
  // Cliente escribe -> bot responde (60 s); cliente escribe -> bot (180 s); una persona escribe; plantilla fallida; cliente sin respuesta.
  await msg(w, { dir: "in", at: at(base) });
  await msg(w, { dir: "out", at: at(base + 60_000), status: "read" });
  await msg(w, { dir: "in", at: at(base + 2 * 3600_000) });
  await msg(w, { dir: "out", at: at(base + 2 * 3600_000 + 180_000), status: "delivered" });
  await msg(w, { dir: "out", sender: "human", at: at(base + 2 * 3600_000 + 30 * MIN), status: "sent" });
  await msg(w, { dir: "out", type: "template", at: at(base + 3 * 3600_000), status: "failed" });
  await msg(w, { dir: "in", at: at(-2 * 3600_000) });

  await dbs.owner.db.insert(handoffs).values({ tenantId: w.tenantId, conversationId: w.conversationId, reason: "Quiere hablar con la doctora", urgency: "alta", takenBy: w.ownerId, createdAt: at(-D) });
  for (const status of ["approved", "edited", "discarded", "pending"] as const)
    await dbs.owner.db.insert(approvals).values({ tenantId: w.tenantId, conversationId: w.conversationId, draft: "d", status, createdAt: at(-D) });

  const appt = (o: { start: number; created: number; status: any; source?: boolean; r24?: number; r2?: number; confirmed?: boolean }) => ({
    tenantId: w.tenantId,
    contactId: w.contactId,
    serviceId: w.serviceId,
    staffId: w.staffId,
    startsAt: at(o.start),
    endsAt: at(o.start + 45 * MIN),
    createdAt: at(o.created),
    status: o.status,
    sourceConversationId: o.source ? w.conversationId : null,
    reminder24hSentAt: o.r24 === undefined ? null : at(o.r24),
    reminder2hSentAt: o.r2 === undefined ? null : at(o.r2),
    confirmedByContact: o.confirmed ?? false,
  });
  await dbs.owner.db.insert(appointments).values([
    appt({ start: -3 * D, created: -10 * D, status: "confirmed", source: true, r24: -4 * D, confirmed: true }),
    appt({ start: -5 * D, created: -9 * D, status: "done", r2: -5 * D }),
    appt({ start: -4 * D, created: -8 * D, status: "no_show" }),
    appt({ start: -2 * D, created: -7 * D, status: "cancelled" }),
    appt({ start: 2 * D, created: -1 * D, status: "confirmed" }),
  ]);

  await dbs.owner.db.insert(calls).values([
    { tenantId: w.tenantId, retellCallId: `c1-${w.tenantId}`, status: "ended", startedAt: at(-D), durationSeconds: 120, sentiment: "Positive" },
    { tenantId: w.tenantId, retellCallId: `c2-${w.tenantId}`, status: "ended", startedAt: at(-D), durationSeconds: 60, disconnectionReason: "call_transfer" },
  ]);
  await dbs.owner.db.insert(usageEvents).values([
    { tenantId: w.tenantId, kind: "llm", tokensIn: 1000, tokensOut: 500, costUsdMicros: 2_000_000, createdAt: at(-D) },
    { tenantId: w.tenantId, kind: "whatsapp", costUsdMicros: 500_000, createdAt: at(-D) },
  ]);
  return w;
}

describe("estadisticas del negocio", () => {
  it("calcula mensajes, respuesta, conversaciones y escalaciones", async () => {
    const w = await busyWorld();
    const s = await getStats(dbs.app.db, w.owner, { days: 30, now: NOW });

    expect(s.range).toMatchObject({ days: 30, timezone: "America/Merida" });
    expect(s.messages).toMatchObject({ inbound: 3, botReplies: 3, humanReplies: 1, templates: 1, outbound: 4, delivered: 2, read: 1, failed: 1 });
    expect(s.messages.deliveryRate).toBeCloseTo(2 / 3);
    expect(s.messages.readRate).toBeCloseTo(1 / 3);
    expect(s.messages.byChannel).toEqual([{ channel: "whatsapp", inbound: 3, outbound: 4 }]);
    expect(s.messages.daily.reduce((a, d) => a + d.inbound, 0)).toBe(3);
    expect(s.messages.byHour.reduce((a, b) => a + b, 0)).toBe(3);
    expect(s.messages.byWeekday.reduce((a, b) => a + b, 0)).toBe(3);

    // Respuesta: 60 s y 180 s (mediana 120 s); el ultimo mensaje del cliente no tiene respuesta.
    expect(s.response).toMatchObject({ measured: 2, unanswered: 1 });
    expect(s.response.medianSeconds).toBeCloseTo(120);
    expect(s.response.p90Seconds).toBeCloseTo(168);

    // Una persona intervino y hubo escalacion: no cuenta como resuelta por el asistente.
    expect(s.conversations).toMatchObject({ active: 1, resolvedByAssistant: 0, handoffs: 1, urgentHandoffs: 1, openHandoffs: 1 });
    expect(s.conversations.handoffRate).toBe(1);
    expect(s.conversations.recentReasons[0]).toMatchObject({ reason: "Quiere hablar con la doctora", urgency: "alta" });
    expect(s.conversations.takenByPerson).toEqual([{ name: "dueno de prueba", count: 1 }]);

    expect(s.approvals).toMatchObject({ total: 4, approved: 1, edited: 1, discarded: 1, pending: 1 });
    expect(s.approvals.approvedAsIsRate).toBeCloseTo(1 / 3);
  });

  it("calcula citas, seguimiento, clientes que regresan, llamadas y costo de IA", async () => {
    const w = await busyWorld();
    const s = await getStats(dbs.app.db, w.owner, { days: 30, now: NOW });

    expect(s.appointments).toMatchObject({ created: 5, byAssistant: 1, manual: 4, upcoming7d: 1, upcomingUnconfirmed7d: 1 });
    expect(s.appointments.assistantShare).toBeCloseTo(0.2);
    expect(s.appointments.outcomes).toEqual({ confirmed: 1, pending: 0, cancelled: 1, noShow: 1, done: 1 });
    expect(s.appointments.cancelRate).toBeCloseTo(0.25);
    expect(s.appointments.noShowRate).toBeCloseTo(0.5);
    expect(s.appointments.avgLeadDays).toBeCloseTo(4.6);
    expect(s.appointments.estimatedRevenue).toBe(1200); // 2 citas (confirmada + realizada) x $600
    expect(s.appointments.topServices).toEqual([{ name: "Limpieza dental", count: 4 }]);
    expect(s.appointments.dailyCreated.reduce((a, d) => a + d.count, 0)).toBe(5);

    expect(s.followUp).toMatchObject({ remindersSent24h: 1, remindersSent2h: 1, returningClients: 1, clientsWithAppointments: 1 });
    expect(s.followUp.reminderCoverage).toBeCloseTo(2 / 3);
    expect(s.followUp.confirmedAfterReminder).toBeCloseTo(0.5);
    expect(s.followUp.noShowRateWithReminder).toBe(0);
    expect(s.followUp.noShowRateWithoutReminder).toBe(1);
    expect(s.followUp.returningRate).toBe(1);

    expect(s.calls).toMatchObject({ total: 2, failed: 0, totalMinutes: 3, transferred: 1 });
    expect(s.calls.avgDurationSeconds).toBeCloseTo(90);
    expect(s.calls.sentiment).toEqual({ positive: 1, neutral: 0, negative: 0, unknown: 1 });

    expect(s.ai).toMatchObject({ tokensIn: 1000, tokensOut: 500 });
    expect(s.ai!.costUsd).toBeCloseTo(2.5);
    expect(s.ai!.costPerConversationUsd).toBeCloseTo(2.5);
    expect(s.contacts.total).toBe(1);
  });

  it("compara contra el periodo anterior y respeta los rangos", async () => {
    const w = await busyWorld();
    // Actividad del periodo anterior (hace 40 dias): 2 mensajes del cliente.
    await msg(w, { dir: "in", at: at(-40 * D) });
    await msg(w, { dir: "in", at: at(-39 * D) });

    const s30 = await getStats(dbs.app.db, w.owner, { days: 30, now: NOW });
    expect(s30.headline.inbound).toEqual({ value: 3, previous: 2 });
    expect(s30.headline.appointmentsCreated.value).toBe(5);

    const s7 = await getStats(dbs.app.db, w.owner, { days: 7, now: NOW });
    expect(s7.range.days).toBe(7);
    expect(s7.messages.inbound).toBe(3);
    expect((await getStats(dbs.app.db, w.owner, { days: 5 as never, now: NOW })).range.days).toBe(30); // rango invalido -> 30
  });

  it("un negocio solo ve lo suyo, y el costo de IA es solo para el dueño", async () => {
    const a = await busyWorld();
    const b = await makeWorld(dbs.owner);
    worlds.push(b);

    const sb = await getStats(dbs.app.db, b.owner, { days: 30, now: NOW });
    expect(sb.messages.inbound).toBe(0);
    expect(sb.appointments.created).toBe(0);
    expect(sb.calls.total).toBe(0);
    expect(sb.messages.byChannel).toEqual([]);
    expect(sb.response.medianSeconds).toBeNull();
    expect(sb.followUp.reminderCoverage).toBeNull();

    const asAgent = await getStats(dbs.app.db, a.agent, { days: 30, now: NOW });
    expect(asAgent.ai).toBeNull();
    expect(asAgent.messages.inbound).toBe(3);
    expect((await getStats(dbs.app.db, a.viewer, { days: 30, now: NOW })).ai).toBeNull();
  });
});
