/** Proceso de trabajo: consume las colas (mensajes entrantes, envios y estados de entrega). */
import { loadConfig, loadEnv } from "./config";
import { createSystem, startSystem } from "./runtime";

loadEnv();
const config = loadConfig();
const system = createSystem(config);
const stopSweeper = startSystem(config, system);

system.log("worker.started", {
  queuePrefix: config.queuePrefix,
  llmMode: config.llmMode || "paid",
  graph: config.graphBaseUrl ?? "https://graph.facebook.com",
});

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  system.log("worker.stopping", { signal });
  stopSweeper();
  await system.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
