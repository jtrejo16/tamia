import { WhatsAppClient } from "@empleado/channels";
import { createDb, type DbHandle } from "@empleado/db";
import { createLLMProvider, type LLMProvider } from "@empleado/llm";
import type { Redis } from "ioredis";
import { loadChannelAccess } from "./channel-access";
import { consoleLogger, type Logger, type WorkerConfig } from "./config";
import { RedisLock } from "./lock";
import { sweepStaleMessages } from "./outbox";
import { createInboundProcessor } from "./processors/inbound";
import { createOutboundProcessor, type Sender } from "./processors/outbound";
import { createReminderScanner } from "./processors/reminders";
import { createStatusProcessor } from "./processors/status";
import { createTemplateSync } from "./processors/template-sync";
import { RedisRateLimiter } from "./ratelimit";
import { HEARTBEAT_INTERVAL_MS, workerBeat } from "@empleado/queue";
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

  const makeSender = (access: { accessToken: string; phoneNumberId: string }): Sender =>
    new WhatsAppClient({
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

  system.workers = startWorkers({
    connection: redis,
    prefix: config.queuePrefix,
    log,
    handlers: { inbound, outbound, status },
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
      .then((r) => r.sent + r.errors > 0 && log("reminders.scan", r))
      .catch((e) => log("reminders.scan_error", { error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        scanning = false;
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

  // Latido: el panel avisa a las personas si el worker deja de dar senales de vida.
  const beat = () => workerBeat(redis, config.queuePrefix).catch(() => {});
  void beat();
  const heartbeat = setInterval(beat, HEARTBEAT_INTERVAL_MS);

  return () => {
    clearInterval(sweep);
    clearInterval(heartbeat);
    clearInterval(reminders);
    clearInterval(templateSync);
  };
}
