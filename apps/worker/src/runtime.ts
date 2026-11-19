import { SocialClient, WhatsAppClient } from "@empleado/channels";
import { createDb, type DbHandle } from "@empleado/db";
import { MercadoPagoClient, emailDepsFromEnv, reconcileSubscriptions, syncAppointmentsToGoogle } from "@empleado/inbox";
import { createLLMProvider, type LLMProvider } from "@empleado/llm";
import type { Redis } from "ioredis";
import { loadChannelAccess } from "./channel-access";
import { consoleLogger, type Logger, type WorkerConfig } from "./config";
import { RedisLock } from "./lock";
import { sweepStaleMessages } from "./outbox";
import { createInboundProcessor } from "./processors/inbound";
import { createOutboundProcessor, type Sender } from "./processors/outbound";
import { createNotificationScanner } from "./processors/notifications";
import { createReminderScanner } from "./processors/reminders";
import { createReviewScanner } from "./processors/reviews";
import { createStatusProcessor } from "./processors/status";
import { createTemplateSync } from "./processors/template-sync";
import { RedisRateLimiter } from "./ratelimit";
import { HEARTBEAT_INTERVAL_MS, publishChange, workerBeat } from "@empleado/queue";
import { createConnection, createEnqueuers, createQueues, type Enqueuers, type Queues } from "./queues";
import { startWorkers, type RunningWorkers } from "./workers";

export interface WorkerSystem {
  db: DbHandle;
  redis: Redis;
  queues: Queues;
  enqueue: Enqueuers;
  llm: LLMProvider;
  log: Logger;
  workers?: RunningWorkers;
  close(): Promise<void>;
}

/** Arma las conexiones y las colas (el webhook las usa solo para encolar). */
export function createSystem(config: WorkerConfig, log: Logger = consoleLogger): WorkerSystem {
  const db = createDb(config.databaseAppUrl, { max: 10 });
  const redis = createConnection(config.redisUrl);
  const queues = createQueues(redis, config.queuePrefix);
  const enqueue = createEnqueuers(queues);
  const llm = createLLMProvider({
    apiKey: config.openRouterApiKey,
    mode: config.llmMode,
    appName: "Empleado Digital",
  });
  const system: WorkerSystem = {
    db,
    redis,
    queues,
    enqueue,
    llm,
    log,
    close: async () => {
      await system.workers?.close();
      await queues.close();
      await db.close();
      redis.disconnect();
    },
  };
  return system;
}

/** Arranca los trabajadores y el barrido de recuperacion de envios. */
export function startSystem(config: WorkerConfig, system: WorkerSystem): () => void {
  const { db, redis, enqueue, llm, log } = system;
  const lock = new RedisLock(redis, config.queuePrefix);
  const limiter = new RedisRateLimiter(redis, config.queuePrefix);

  const makeSender = (access: { accessToken: string; phoneNumberId: string; channelType: string }): Sender =>
    access.channelType === "messenger" || access.channelType === "instagram"
      ? new SocialClient({
          accessToken: access.accessToken,
          accountId: access.phoneNumberId,
          channelType: access.channelType,
          apiVersion: config.graphApiVersion,
          baseUrl: config.graphBaseUrl,
        })
      : new WhatsAppClient({
          accessToken: access.accessToken,
          phoneNumberId: access.phoneNumberId,
          apiVersion: config.graphApiVersion,
          baseUrl: config.graphBaseUrl,
        });

  const inbound = createInboundProcessor({
    db: db.db,
    llm,
    enqueueOutbound: enqueue.outbound,
    lock,
    limiter,
    log,
    markRead: async (job) => {
      const access = await loadChannelAccess(db.db, config.encryptionKey, job.tenantId, job.channelId);
      if (!access?.accessToken) return;
      await new WhatsAppClient({
        accessToken: access.accessToken,
        phoneNumberId: access.phoneNumberId,
        apiVersion: config.graphApiVersion,
        baseUrl: config.graphBaseUrl,
      }).markRead(job.message.id);
    },
  });
  const outbound = createOutboundProcessor({ db: db.db, key: config.encryptionKey, makeSender, lock, log });
  const status = createStatusProcessor({ db: db.db, log });
  const notify = () => void publishChange(redis, config.queuePrefix).catch(() => {});

  system.workers = startWorkers({
    connection: redis,
    prefix: config.queuePrefix,
    log,
    // Al terminar cada trabajo se avisa a los paneles abiertos para que se actualicen al instante.
    handlers: {
      inbound: (d) => inbound(d).finally(notify),
      outbound: (d, a) => outbound(d, a).finally(notify),
      status: (d) => status(d).finally(notify),
    },
  });

  const sweep = setInterval(() => {
    sweepStaleMessages(db.db, enqueue.outbound)
      .then((n) => n > 0 && log("sweeper.requeued", { count: n }))
      .catch((e) => log("sweeper.error", { error: e instanceof Error ? e.message : String(e) }));
  }, 30_000);

  // Recordatorios de cita (24 h y 2 h antes): se revisa cada minuto.
  const scanReminders = createReminderScanner({ db: db.db, enqueueOutbound: enqueue.outbound, log });
  let scanning = false;
  const reminders = setInterval(() => {
    if (scanning) return; // no encimar revisiones si una tarda
    scanning = true;
    scanReminders()
      .then((r) => {
        if (r.sent + r.errors > 0) {
          log("reminders.scan", r);
          notify();
        }
      })
      .catch((e) => log("reminders.scan_error", { error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        scanning = false;
      });
  }, 60_000);

  // Avisos al equipo (alguien pide una persona) y solicitudes de resena tras la cita: se revisan cada minuto.
  const email = emailDepsFromEnv(process.env);
  const scanNotifications = createNotificationScanner({
    db: db.db,
    key: config.encryptionKey,
    makeSender,
    email,
    baseUrl: process.env.PUBLIC_BASE_URL?.trim() || null,
    log,
  });
  const scanReviews = createReviewScanner({ db: db.db, enqueueOutbound: enqueue.outbound, log });
  let scanningExtras = false;
  const extras = setInterval(() => {
    if (scanningExtras) return;
    scanningExtras = true;
    Promise.all([
      scanNotifications().then((r) => r.sent + r.errors > 0 && log("notifications.scan", r)),
      scanReviews().then((r) => {
        if (r.sent + r.errors > 0) {
          log("reviews.scan", r);
          notify();
        }
      }),
    ])
      .catch((e) => log("extras.scan_error", { error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        scanningExtras = false;
      });
  }, 60_000);

  // Estado de las plantillas en Meta: al arrancar y cada 10 minutos.
  const syncTemplatesNow = createTemplateSync({
    db: db.db,
    log,
    graph: { key: config.encryptionKey, apiVersion: config.graphApiVersion, baseUrl: config.graphBaseUrl },
  });
  const runSync = () => syncTemplatesNow().catch((e) => log("templates.sync_error", { error: e instanceof Error ? e.message : String(e) }));
  void runSync();
  const templateSync = setInterval(runSync, 10 * 60_000);

  // Conciliacion de suscripciones: red de seguridad si se pierde un aviso (webhook) de Mercado Pago.
  // Solo si hay clave de Mercado Pago. Cada suscripcion se revisa como maximo cada hora; la vuelta es cada 15 min.
  const mpToken = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
  let reconciling = false;
  const reconcile = () => {
    if (!mpToken || reconciling) return;
    reconciling = true;
    reconcileSubscriptions(db.db, new MercadoPagoClient({ accessToken: mpToken, baseUrl: process.env.MERCADOPAGO_BASE_URL || undefined }), { log })
      .then((r) => {
        if (r.checked + r.errors > 0) log("billing.reconcile", { ...r });
        if (r.changed > 0) notify();
      })
      .catch((e) => log("billing.reconcile_error", { error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        reconciling = false;
      });
  };
  const reconcileStart = setTimeout(reconcile, 30_000);
  const reconcileTimer = setInterval(reconcile, 15 * 60_000);

  // Google Calendar: refleja las citas confirmadas / movidas / canceladas en el calendario de cada negocio que lo
  // conecto. Cada minuto; solo si el servidor tiene las credenciales de Google.
  const gClientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const gClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  let calendarSyncing = false;
  const calendarSync = () => {
    if (!gClientId || !gClientSecret || calendarSyncing) return;
    calendarSyncing = true;
    syncAppointmentsToGoogle(db.db, { clientId: gClientId, clientSecret: gClientSecret, key: config.encryptionKey }, { log })
      .then((r) => {
        if (r.checked + r.errors > 0) log("calendar.sync", { ...r });
        if (r.created + r.updated + r.deleted > 0) notify();
      })
      .catch((e) => log("calendar.sync_failed", { error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        calendarSyncing = false;
      });
  };
  const calendarTimer = setInterval(calendarSync, 60_000);

  // Latido: el panel avisa a las personas si el worker deja de dar senales de vida.
  const beat = () => workerBeat(redis, config.queuePrefix).catch(() => {});
  void beat();
  const heartbeat = setInterval(beat, HEARTBEAT_INTERVAL_MS);

  return () => {
    clearInterval(sweep);
    clearInterval(heartbeat);
    clearInterval(reminders);
    clearInterval(extras);
    clearInterval(templateSync);
    clearTimeout(reconcileStart);
    clearInterval(reconcileTimer);
    clearInterval(calendarTimer);
  };
}
