// Las colas viven en @empleado/queue para que el panel (que tambien encola envios) las comparta.
export {
  JOB_OPTIONS,
  QUEUE,
  createConnection,
  createEnqueuers,
  createQueues,
  jobId,
  type Enqueuers,
  type Queues,
} from "@empleado/queue";
