/**
 * Simula que un CLIENTE escribe por WhatsApp: manda al webhook local un POST firmado igual al
 * que mandaria Meta.
 *
 *   pnpm --filter @empleado/worker dev:simulate -- --text "Hola, quiero una limpieza"
 *       [--from 5219841112222] [--name Ana] [--phone-number-id demo-sonrisa-0001]
 */
import { signBody } from "@empleado/channels";
import { loadEnv } from "../config";

loadEnv();
const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};

const secret = process.env.META_APP_SECRET;
if (!secret) {
  console.error("Falta META_APP_SECRET en .env (para desarrollo local puede ser cualquier texto largo).");
  process.exit(1);
}

const text = arg("text", "Hola, buenas tardes");
const from = arg("from", "5219841112222");
const phoneNumberId = arg("phone-number-id", "demo-sonrisa-0001");
const url = arg("url", `http://localhost:${process.env.WEBHOOK_PORT || 3001}/webhooks/whatsapp`);

const body = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "SIMULATED_WABA",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: phoneNumberId, display_phone_number: "0" },
            contacts: [{ profile: { name: arg("name", "Ana") }, wa_id: from }],
            messages: [
              {
                from,
                id: `wamid.SIM${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: "text",
                text: { body: text },
              },
            ],
          },
        },
      ],
    },
  ],
});

const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "x-hub-signature-256": signBody(body, secret) },
  body,
});
console.log(`Cliente (+${from}): ${text}`);
console.log(`Webhook respondió ${res.status} ${await res.text()}`);
