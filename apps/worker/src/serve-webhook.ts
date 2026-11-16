/** Recibe los webhooks de WhatsApp: valida la firma, encola y responde 200 enseguida. */
import { consoleLogger, loadConfig, loadEnv } from "./config";
import { createSystem } from "./runtime";
import { createHandlers, createWebhookServer, WEBHOOK_PATH } from "./webhook-server";

loadEnv();
const config = loadConfig();

const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
const appSecret = process.env.META_APP_SECRET;
if (!verifyToken) throw new Error("Falta WHATSAPP_VERIFY_TOKEN en .env");
if (!appSecret) {
  throw new Error(
    "Falta META_APP_SECRET en .env. Lo encuentras en developers.facebook.com → tu app → Configuración → Básica → Clave secreta de la app.",
  );
}

const system = createSystem(config, consoleLogger);
const server = createWebhookServer(createHandlers(system, { verifyToken, appSecret }, consoleLogger), consoleLogger);

server.listen(config.webhookPort, () => {
  consoleLogger("webhook.listening", { port: config.webhookPort, path: WEBHOOK_PATH });
});

async function shutdown(signal: string) {
  consoleLogger("webhook.stopping", { signal });
  server.close();
  await system.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
