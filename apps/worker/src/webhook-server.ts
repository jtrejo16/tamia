import { createWhatsAppWebhook, type WebhookHandlers } from "@empleado/channels";
import { resolveChannel } from "@empleado/db";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "./config";
import type { WorkerSystem } from "./runtime";

export const WEBHOOK_PATH = "/webhooks/whatsapp";

export function createHandlers(
  system: WorkerSystem,
  secrets: { verifyToken: string; appSecret: string },
  log: Logger,
): WebhookHandlers {
  return createWhatsAppWebhook({
    verifyToken: secrets.verifyToken,
    appSecret: secrets.appSecret,
    resolveChannel: (phoneNumberId) => resolveChannel(system.db.db, "whatsapp", phoneNumberId),
    resolveSocialChannel: (type, accountId) => resolveChannel(system.db.db, type, accountId),
    enqueueInbound: system.enqueue.inbound,
    enqueueStatus: system.enqueue.status,
    log,
  });
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Servidor HTTP minimo para el webhook. Cuando exista el panel (Next.js), la misma logica se
 * monta en `app/api/webhooks/whatsapp/route.ts` con `export const { GET, POST } = handlers`.
 */
export function createWebhookServer(handlers: WebhookHandlers, log: Logger): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const send = (status: number, body: string) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(body);
    };

    try {
      if (url.pathname === "/health") return send(200, "ok");
      if (url.pathname !== WEBHOOK_PATH) return send(404, "Not found");

      let response: Response;
      if (req.method === "GET") {
        response = await handlers.GET(new Request(url, { method: "GET" }));
      } else if (req.method === "POST") {
        const body = await readBody(req, 1_100_000);
        if (!body) return send(413, "Payload too large");
        response = await handlers.POST(
          new Request(url, {
            method: "POST",
            headers: Object.fromEntries(
              Object.entries(req.headers).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])),
            ),
            body: new Uint8Array(body),
          }),
        );
      } else {
        return send(405, "Method not allowed");
      }
      send(response.status, await response.text());
    } catch (error) {
      log("webhook.error", { error: error instanceof Error ? error.message : String(error) });
      send(500, "Internal error");
    }
  });
}
