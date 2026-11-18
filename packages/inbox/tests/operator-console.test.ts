import { auditLog, channels, messages, subscriptions, users } from "@empleado/db";
import { parseKey } from "@empleado/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  billingState,
  checkWhatsAppConnection,
  healthOf,
  logSupportAction,
  operatorExtendTrial,
  operatorOverview,
  operatorSupportContext,
  operatorTenantDetail,
  summarize,
  type OperatorClient,
} from "../src";
import { addMessage, dropWorld, env, makeWorld, openDbs, type Dbs, type World } from "./helpers";
import type { OperatorOverviewRow } from "@empleado/db";

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

const NOW = new Date("2027-03-10T18:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

function row(over: Partial<OperatorOverviewRow> = {}): OperatorOverviewRow {
  return {
    id: "t1", name: "Clínica", slug: "clinica", vertical: "dental", status: "active", plan: "profesional", createdAt: day(-30), timezone: "America/Merida",
    ownerEmail: "d@x.mx", ownerName: "Dra", members: 1, subStatus: "active", trialEndsAt: day(-20), currentPeriodEnd: day(20), cardAuthorized: true, hasCheckout: true,
    reconciledAt: null, subUpdatedAt: null,
    channels: [{ type: "whatsapp", status: "active", hasToken: true, quality: "GREEN", account: "+52 999" }],
    lastInboundAt: day(-0.5), lastOutboundAt: day(-0.4), inbound7d: 20, bot7d: 18, failed24h: 0, openHandoffs: 0, pendingApprovals: 0, appointmentsNext7d: 3,
    voiceEnabled: false, voiceSynced: false, calendarStatus: null, templatesRejected: 0, templatesPending: 0,
    ...over,
  };
}

describe("estado de cobro", () => {
  it("clasifica a cada cliente", () => {
    expect(billingState(row({ status: "pending" }), NOW).bucket).toBe("pending");
    expect(billingState(row({ status: "paused" }), NOW).bucket).toBe("paused");
    expect(billingState(row({ subStatus: null }), NOW).bucket).toBe("none");
    expect(billingState(row({ subStatus: "comped" }), NOW).bucket).toBe("comped");

    const paid = billingState(row(), NOW);
    expect(paid).toMatchObject({ bucket: "paid", daysLeft: 20, allowed: true, mrrMxn: 1499 });

    expect(billingState(row({ currentPeriodEnd: day(5) }), NOW)).toMatchObject({ bucket: "due_soon", daysLeft: 5, mrrMxn: 1499 });
    // Vencio hace 10 dias (mas alla de los 3 de gracia): sin pago vigente.
    expect(billingState(row({ currentPeriodEnd: day(-10) }), NOW)).toMatchObject({ bucket: "overdue", allowed: false, mrrMxn: 0 });
    expect(billingState(row({ subStatus: "past_due", currentPeriodEnd: day(-10) }), NOW).bucket).toBe("overdue");

    expect(billingState(row({ subStatus: "trialing", trialEndsAt: day(10), currentPeriodEnd: null }), NOW)).toMatchObject({ bucket: "trial", daysLeft: 10, mrrMxn: 0 });
    expect(billingState(row({ subStatus: "trialing", trialEndsAt: day(2), currentPeriodEnd: null }), NOW).bucket).toBe("trial_ending");
    expect(billingState(row({ subStatus: "trialing", trialEndsAt: day(-5), currentPeriodEnd: null, cardAuthorized: false }), NOW)).toMatchObject({ bucket: "overdue", reason: "trial_ended" });

    expect(billingState(row({ subStatus: "canceled", currentPeriodEnd: day(8) }), NOW)).toMatchObject({ bucket: "canceled", daysLeft: 8, mrrMxn: 0 });
  });
});

describe("salud del cliente", () => {
  it("un negocio sano no tiene problemas", () => {
    expect(healthOf(row(), NOW)).toEqual({ level: "ok", issues: [] });
  });

  it("no evalua a negocios que no estan activos", () => {
    expect(healthOf(row({ status: "pending", channels: [] }), NOW).level).toBe("na");
  });

  it("detecta falta de canal, canales caidos y mensajes fallidos", () => {
    const noChannel = healthOf(row({ channels: [] }), NOW);
    expect(noChannel.level).toBe("error");
    expect(noChannel.issues[0]!.code).toBe("no_channel");
    // Recien dado de alta: solo advertencia.
    expect(healthOf(row({ channels: [], createdAt: day(-1) }), NOW).level).toBe("warn");

    const broken = healthOf(
      row({ channels: [{ type: "whatsapp", status: "active", hasToken: true, quality: "RED", account: null }, { type: "messenger", status: "error", hasToken: true, quality: null, account: null }], failed24h: 12 }),
      NOW,
    );
    expect(broken.level).toBe("error");
    expect(broken.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["quality_whatsapp", "channel_error_messenger", "failed_messages"]));

    expect(healthOf(row({ channels: [{ type: "whatsapp", status: "active", hasToken: true, quality: "GREEN", account: null }, { type: "instagram", status: "paused", hasToken: false, quality: null, account: null }] }), NOW).issues.map((i) => i.code)).toContain("channel_off_instagram");
  });

  it("avisa de silencio, mensajes sin respuesta y pendientes", () => {
    expect(healthOf(row({ inbound7d: 0 }), NOW).issues.map((i) => i.code)).toContain("silent");
    const unanswered = healthOf(row({ lastInboundAt: day(-0.1), lastOutboundAt: day(-0.5) }), NOW);
    expect(unanswered.issues.map((i) => i.code)).toContain("unanswered");
    const misc = healthOf(row({ openHandoffs: 2, pendingApprovals: 5, calendarStatus: "error", voiceEnabled: true, voiceSynced: false, templatesRejected: 1 }), NOW);
    expect(misc.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["handoffs", "approvals", "calendar", "voice", "templates"]));
    expect(misc.level).toBe("warn");
  });
});

describe("resumen de la plataforma", () => {
  it("cuenta clientes por estado e ingreso", () => {
    const mk = (over: Partial<OperatorOverviewRow>): OperatorClient => {
      const r = row(over);
      return { ...r, billing: billingState(r, NOW), health: healthOf(r, NOW) };
    };
    const s = summarize([
      mk({}), // paga, profesional (1499)
      mk({ currentPeriodEnd: day(3), plan: "esencial" }), // por vencer (799)
      mk({ currentPeriodEnd: day(-10) }), // vencido
      mk({ subStatus: "trialing", trialEndsAt: day(2), currentPeriodEnd: null }), // prueba por terminar
      mk({ status: "pending" }),
      mk({ subStatus: "comped" }),
      mk({ channels: [] }),
    ]);
    expect(s).toMatchObject({ total: 7, paying: 3, dueSoon: 1, overdue: 1, trial: 1, trialEnding: 1, pendingApproval: 1, comped: 1, withoutChannel: 1 });
    expect(s.mrrMxn).toBe(1499 + 799 + 1499); // el que no tiene canal tambien paga
    expect(s.renewingNext7dMxn).toBe(799);
  });
});

// ------------------------------------------------------------------ con base de datos

async function operatorWorld() {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  await dbs.owner.db.update(users).set({ isOperator: true }).where(eq(users.id, w.ownerId));
  return w;
}

describe("consola del operador (base de datos)", () => {
  it("solo el operador ve el resumen; el dueño de un negocio no", async () => {
    const op = await operatorWorld();
    const client = await makeWorld(dbs.owner);
    worlds.push(client);
    await dbs.owner.db.insert(subscriptions).values({ tenantId: client.tenantId, status: "active", currentPeriodEnd: new Date(Date.now() + 3 * 86_400_000), cardAuthorized: true });
    await addMessage(dbs.owner, client, { direction: "in", body: "hola", createdAt: new Date(Date.now() - 3600_000) });

    expect(await operatorOverview(dbs.app.db, client.ownerId)).toMatchObject({ ok: false, error: "forbidden" });

    const r = await operatorOverview(dbs.app.db, op.ownerId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.clients.find((x) => x.id === client.tenantId)!;
    expect(c).toBeDefined();
    expect(c.billing.bucket).toBe("due_soon");
    expect(c.inbound7d).toBe(1);
    expect(c.channels).toHaveLength(1);
    expect(c.channels[0]).toMatchObject({ type: "whatsapp" });
    expect(JSON.stringify(c)).not.toMatch(/credentials|accessToken|refreshToken/i); // nunca claves
    expect(r.summary.total).toBeGreaterThanOrEqual(2);
  });

  it("el detalle junta cobro, canales, equipo, bitacora y mensajes fallidos", async () => {
    const op = await operatorWorld();
    const client = await makeWorld(dbs.owner);
    worlds.push(client);
    await dbs.owner.db.insert(subscriptions).values({ tenantId: client.tenantId, status: "trialing", trialEndsAt: new Date(Date.now() + 5 * 86_400_000) });
    await dbs.owner.db.insert(messages).values({
      tenantId: client.tenantId, conversationId: client.conversationId, channelId: client.channelId,
      direction: "out", sender: "bot", body: "x", status: "failed", error: "Re-engagement message",
    });

    const forbidden = await operatorTenantDetail(dbs.app.db, client.ownerId, client.tenantId, { paymentsEnabled: true, retellConfigured: false });
    expect(forbidden).toMatchObject({ ok: false, error: "forbidden" });

    const r = await operatorTenantDetail(dbs.app.db, op.ownerId, client.tenantId, { paymentsEnabled: true, retellConfigured: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.detail.client.billing.bucket).toBe("trial");
    expect(r.detail.billing.subscription?.status).toBe("trialing");
    expect(r.detail.members.map((m) => m.role)).toContain("owner");
    expect(r.detail.failures[0]).toMatchObject({ channel: "whatsapp", error: "Re-engagement message" });
    expect(r.detail.voice.retellConfigured).toBe(false);
    expect(await operatorTenantDetail(dbs.app.db, op.ownerId, "00000000-0000-0000-0000-000000000000", { paymentsEnabled: true, retellConfigured: false })).toMatchObject({ ok: false, error: "not_found" });
  });

  it("el soporte actua como dueño del negocio solo si eres operador, y deja constancia", async () => {
    const op = await operatorWorld();
    const client = await makeWorld(dbs.owner);
    worlds.push(client);

    expect(await operatorSupportContext(dbs.app.db, client.ownerId, client.tenantId)).toBeNull(); // un dueño no puede entrar a OTRO negocio
    expect(await operatorSupportContext(dbs.app.db, op.ownerId, "00000000-0000-0000-0000-000000000000")).toBeNull();
    const ctx = await operatorSupportContext(dbs.app.db, op.ownerId, client.tenantId);
    expect(ctx).toEqual({ tenantId: client.tenantId, userId: op.ownerId, role: "owner" });

    await logSupportAction(dbs.app.db, ctx!, "whatsapp_connect", { phoneNumberId: "123" });
    const log = await dbs.owner.db.select().from(auditLog).where(and(eq(auditLog.tenantId, client.tenantId), eq(auditLog.action, "operator.support.whatsapp_connect")));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ userId: op.ownerId, diff: { phoneNumberId: "123" } });
  });

  it("extiende la prueba (solo operador, solo en prueba, 1 a 90 dias)", async () => {
    const op = await operatorWorld();
    const client = await makeWorld(dbs.owner);
    worlds.push(client);
    const end = new Date(Date.now() + 2 * 86_400_000);
    await dbs.owner.db.insert(subscriptions).values({ tenantId: client.tenantId, status: "trialing", trialEndsAt: end });

    expect(await operatorExtendTrial(dbs.app.db, client.ownerId, client.tenantId, 7)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await operatorExtendTrial(dbs.app.db, op.ownerId, client.tenantId, 0)).toMatchObject({ ok: false, error: "invalid" });
    expect(await operatorExtendTrial(dbs.app.db, op.ownerId, client.tenantId, 91)).toMatchObject({ ok: false, error: "invalid" });
    expect(await operatorExtendTrial(dbs.app.db, op.ownerId, client.tenantId, 7)).toEqual({ ok: true });

    const [sub] = await dbs.owner.db.select().from(subscriptions).where(eq(subscriptions.tenantId, client.tenantId));
    expect(Math.round((sub!.trialEndsAt!.getTime() - end.getTime()) / 86_400_000)).toBe(7);

    // Un negocio que ya paga no es "de prueba": no se toca.
    await dbs.owner.db.update(subscriptions).set({ status: "active" }).where(eq(subscriptions.tenantId, client.tenantId));
    expect(await operatorExtendTrial(dbs.app.db, op.ownerId, client.tenantId, 7)).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("equipo con acceso a varios negocios", () => {
  it("la lista de equipo muestra solo a las personas del negocio (no las membresias propias de otros)", async () => {
    const op = await operatorWorld();
    const client = await makeWorld(dbs.owner);
    worlds.push(client);
    const r = await operatorTenantDetail(dbs.app.db, op.ownerId, client.tenantId, { paymentsEnabled: false, retellConfigured: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.detail.members.map((m) => m.userId);
    expect(ids).toEqual(expect.arrayContaining([client.ownerId, client.agentId, client.viewerId]));
    expect(ids).not.toContain(op.ownerId);
  });

  it("no se puede dejar un negocio sin dueño aunque quien lo hace sea dueño de OTRO negocio", async () => {
    const a = await makeWorld(dbs.owner);
    const b = await makeWorld(dbs.owner);
    worlds.push(a, b);
    // El dueño de A tambien es dueño de B.
    const { memberships } = await import("@empleado/db");
    await dbs.owner.db.insert(memberships).values({ tenantId: b.tenantId, userId: a.ownerId, role: "owner" });
    const { changeRole, removeMember } = await import("../src");

    expect(await changeRole(dbs.app.db, a.owner, a.ownerId, "viewer")).toMatchObject({ ok: false, error: "last_owner" });
    expect(await removeMember(dbs.app.db, a.owner, a.ownerId)).toMatchObject({ ok: false, error: "last_owner" });
  });
});

describe("comprobar WhatsApp en vivo", () => {
  it("dice si la clave y el numero siguen siendo validos", async () => {
    const w = await makeWorld(dbs.owner);
    worlds.push(w);
    const key = parseKey(env("ENCRYPTION_KEY"));
    const ctx = { tenantId: w.tenantId, userId: w.ownerId, role: "owner" as const };

    // Sin credenciales guardadas.
    const none = await checkWhatsAppConnection(dbs.app.db, { key, apiVersion: "v23.0" }, ctx);
    expect(none).toMatchObject({ connected: false });
    expect(none.problems[0]).toContain("No hay un número");

    const { sealChannelCredentials } = await import("@empleado/channels");
    await dbs.owner.db.update(channels).set({ credentialsEnc: sealChannelCredentials({ accessToken: "TOKEN-DE-PRUEBA-1234567890" }, key, w.tenantId, w.channelId) }).where(eq(channels.id, w.channelId));

    const ok = (async () => new Response(JSON.stringify({ display_phone_number: "+52 999 111 2222", verified_name: "Clínica", quality_rating: "GREEN" }), { status: 200 })) as unknown as typeof fetch;
    expect(await checkWhatsAppConnection(dbs.app.db, { key, apiVersion: "v23.0", baseUrl: "https://graph.test", fetch: ok }, ctx)).toMatchObject({ connected: true, tokenValid: true, displayPhone: "+52 999 111 2222", quality: "GREEN", problems: [] });

    const bad = (async () => new Response(JSON.stringify({ error: { message: "Invalid OAuth access token", code: 190 } }), { status: 401 })) as unknown as typeof fetch;
    const r = await checkWhatsAppConnection(dbs.app.db, { key, apiVersion: "v23.0", baseUrl: "https://graph.test", fetch: bad }, ctx);
    expect(r).toMatchObject({ connected: true, tokenValid: false });
    expect(r.problems[0]).toContain("rechazó");
  });
});
