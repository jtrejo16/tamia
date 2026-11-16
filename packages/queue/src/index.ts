import type { InboundJobData, OutboundJobData, StatusJobData } from "@empleado/channels";
import { Queue, type JobsOptions } from "bullmq";
import IORedis, { type Redis } from "ioredis";

export const QUEUE = {
  inbound: "wa-inbound",
  outbound: "wa-outbound",
  status: "wa-status",
} as const;

/** BullMQ exige maxRetriesPerRequest=null en las conexiones de los workers. */
export function createConnection(url: string): Redis {
  return new IORedis(url, { maxRetriesPerRequest: null });
}

export const JOB_OPTIONS: Record<keyof typeof QUEUE, JobsOptions> = {
  inbound: {
    attempts: 3,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86_400 },
  },
  outbound: {
    attempts: 5,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86_400 },
  },
  // Un estado puede llegar antes de que guardemos el wamid del envio: se reintenta pronto.
  status: {
    attempts: 6,
    backoff: { type: "fixed", delay: 3000 },
    removeOnComplete: { age: 600 },
    removeOnFail: { age: 3600 },
  },
};

/** BullMQ no permite ":" en ids propios. El id da deduplicacion gratis dentro de la cola. */
export const jobId = (kind: string, id: string): string => `${kind}-${id}`.replace(/[:\s]/g, "_");

export interface Queues {
  inbound: Queue<InboundJobData>;
  outbound: Queue<OutboundJobData>;
  status: Queue<StatusJobData>;
  close(): Promise<void>;
}

export function createQueues(connection: Redis, prefix: string): Queues {
  const inbound = new Queue<InboundJobData>(QUEUE.inbound, { connection, prefix });
  const outbound = new Queue<OutboundJobData>(QUEUE.outbound, { connection, prefix });
  const status = new Queue<StatusJobData>(QUEUE.status, { connection, prefix });
  return {
    inbound,
    outbound,
    status,
    close: async () => {
      await Promise.all([inbound.close(), outbound.close(), status.close()]);
    },
  };
}

export interface Enqueuers {
  inbound(data: InboundJobData): Promise<void>;
  outbound(data: OutboundJobData): Promise<void>;
  status(data: StatusJobData): Promise<void>;
}

export function createEnqueuers(queues: Queues): Enqueuers {
  return {
    async inbound(data) {
      await queues.inbound.add("message", data, { ...JOB_OPTIONS.inbound, jobId: jobId("in", data.message.id) });
    },
    async outbound(data) {
      await queues.outbound.add("send", data, { ...JOB_OPTIONS.outbound, jobId: jobId("out", data.messageId) });
    },
    async status(data) {
      await queues.status.add("status", data, {
        ...JOB_OPTIONS.status,
        jobId: jobId("st", `${data.status.id}-${data.status.status}`),
      });
    },
  };
}

// ---------------------------------------------------------------- latido del worker

export const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TTL_SECONDS = 30;
const heartbeatKey = (prefix: string) => `${prefix}:worker:heartbeat`;

/** El worker llama a esto cada pocos segundos para decir "sigo vivo". */
export async function workerBeat(redis: Redis, prefix: string): Promise<void> {
  await redis.set(heartbeatKey(prefix), String(Date.now()), "EX", HEARTBEAT_TTL_SECONDS);
}

/** El panel lo consulta para avisar si los mensajes se estan quedando sin enviar. */
export async function isWorkerAlive(redis: Redis, prefix: string): Promise<boolean> {
  return (await redis.exists(heartbeatKey(prefix))) === 1;
}

// ---------------------------------------------------------------- limite de velocidad

export interface RateLimiter {
  /** true si todavia cabe otro evento dentro del limite. */
  allow(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}

/**
 * Contador por ventana en Redis. Se usa para topar mensajes por cliente (spam, costo de IA)
 * y los intentos de inicio de sesion.
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  async allow(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const redisKey = `${this.prefix}:rl:${key}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) await this.redis.expire(redisKey, windowSeconds);
    return count <= limit;
  }
}

export const unlimited: RateLimiter = { allow: async () => true };
