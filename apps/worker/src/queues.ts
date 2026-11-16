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
