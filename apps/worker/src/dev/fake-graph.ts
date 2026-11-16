/**
 * Graph API FALSA para desarrollo: imprime lo que el sistema "enviaria" a WhatsApp y, si se
 * indica WEBHOOK_URL, devuelve avisos firmados de entregado/leido como haria Meta.
 *
 *   pnpm --filter @empleado/worker dev:fake-graph
 *   (y en .env: GRAPH_BASE_URL=http://localhost:4010)
 */
import { signBody } from "@empleado/channels";
import { createServer } from "node:http";
import { loadEnv } from "../config";

loadEnv();
const port = Number(process.env.FAKE_GRAPH_PORT || 4010);
const webhookUrl = process.env.FAKE_GRAPH_WEBHOOK_URL || `http://localhost:${process.env.WEBHOOK_PORT || 3001}/webhooks/whatsapp`;
const appSecret = process.env.META_APP_SECRET || "";
let counter = 0;

async function emitStatus(phoneNumberId: string, wamid: string, to: string, status: "delivered" | "read", delayMs: number) {
  await new Promise((r) => setTimeout(r, delayMs));
  if (!appSecret) return;
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "FAKE_WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: phoneNumberId, display_phone_number: "0" },
              statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: to }],
            },
          },
        ],
      },
    ],
  });
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signBody(body, appSecret) },
    body,
  }).catch(() => {});
}

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const match = /^\/(v[\d.]+)\/([^/]+)\/messages$/.exec(req.url ?? "");

  if (req.method !== "POST" || !match) {
    res.writeHead(404).end(JSON.stringify({ error: { message: "ruta no soportada por el Graph API falso", code: 100 } }));
    return;
  }
  if (!req.headers.authorization?.startsWith("Bearer ") || req.headers.authorization.length < 12) {
    res.writeHead(401).end(JSON.stringify({ error: { message: "token invalido", code: 190 } }));
    return;
  }

  const phoneNumberId = match[2]!;
  const body = JSON.parse(raw) as { to?: string; type?: string; text?: { body: string }; location?: Record<string, unknown>; status?: string };

  if (body.status === "read") {
    console.log(`\n  ✓✓ (leído) mensaje del cliente`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ success: true }));
    return;
  }

  const wamid = `wamid.FAKE${Date.now().toString(36)}${++counter}`;
  const bar = "─".repeat(60);
  console.log(`\n${bar}\n  📱 WhatsApp → +${body.to}   (${body.type})`);
  if (body.type === "text") console.log(`\n${body.text?.body}\n`);
  else console.log(`\n${JSON.stringify(body.location)}\n`);
  console.log(`  id: ${wamid}\n${bar}`);

  res.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({ messaging_product: "whatsapp", contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: wamid }] }),
  );

  void emitStatus(phoneNumberId, wamid, body.to ?? "", "delivered", 800);
  void emitStatus(phoneNumberId, wamid, body.to ?? "", "read", 2500);
}).listen(port, () => {
  console.log(`Graph API FALSO escuchando en http://localhost:${port}  (avisos de estado a ${webhookUrl})`);
});
