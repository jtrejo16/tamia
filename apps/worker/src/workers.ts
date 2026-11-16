import type { InboundJobData, OutboundJobData, StatusJobData } from "@empleado/channels";
import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "./config";
import type { Attempt } from "./processors/outbound";
import { QUEUE } from "./queues";

export interface WorkerHandlers {
  inbound(data: InboundJobData): Promise<unknown>;
  outbound(data: OutboundJobData, attempt: Attempt): Promise<unknown>;
  status(data: StatusJobData): Promise<unknown>;
}

export interface RunningWorkers {
  close(): Promise<void>;
}

/** Conecta los procesadores a las colas de BullMQ. */
export function startWorkers(options: {
  connection: Redis;
  prefix: string;
  handlers: WorkerHandlers;
  log?: Logger;
  concurrency?: { inbound?: number; outbound?: number; status?: number };
}): RunningWorkers {
  const { connection, prefix, handlers, log } = options;
  const c = options.concurrency ?? {};

  const inbound = new Worker<InboundJobData>(QUEUE.inbound, (job) => handlers.inbound(job.data), {
    connection,
    prefix,
    concurrency: c.inbound ?? 5,
  });
  const outbound = new Worker<OutboundJobData>(
    QUEUE.outbound,
    (job) =>
      handlers.outbound(job.data, { attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1 }),
    { connection, prefix, concurrency: c.outbound ?? 5 },
  );
  const status = new Worker<StatusJobData>(QUEUE.status, (job) => handlers.status(job.data), {
    connection,
    prefix,
    concurrency: c.status ?? 5,
  });

  for (const [name, worker] of [
    ["inbound", inbound],
    ["outbound", outbound],
    ["status", status],
  ] as const) {
    worker.on("failed", (job, err) =>
      log?.("job.failed", { queue: name, jobId: job?.id, attempt: job?.attemptsMade, error: err.message }),
    );
    worker.on("error", (err) => log?.("worker.error", { queue: name, error: err.message }));
  }

  return {
    close: async () => {
      await Promise.all([inbound.close(), outbound.close(), status.close()]);
    },
  };
}
