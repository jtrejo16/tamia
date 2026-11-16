/**
 * Llamadas de WhatsApp (API oficial de Meta) de un numero: ver, activar apuntando a Retell, o apagar.
 *
 *   pnpm --filter @empleado/worker calling -- --slug sonrisa status
 *   pnpm --filter @empleado/worker calling -- --slug sonrisa enable [--sip-host sip.retellai.com] [--sip-port 5061]
 *   pnpm --filter @empleado/worker calling -- --slug sonrisa disable
 *
 * `enable` guarda ANTES una copia de la configuracion actual en .wa-calling-backup.json (ignorada por git);
 * `disable` apaga las llamadas y la senalizacion SIP. La clave de Meta se lee cifrada del canal: no se muestra.
 * Opcional: --phone-number-id <id> para operar sobre OTRO numero de la misma cuenta.
 */
import { loadChannelAccess } from "@empleado/inbox";
import { channels, createDb, tenants } from "@empleado/db";
import { parseKey } from "@empleado/shared";
import { and, eq } from "drizzle-orm";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnv } from "../config";

loadEnv();
const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const command = argv.find((a) => ["status", "enable", "disable"].includes(a));
const slug = arg("slug");
if (!slug || !command) {
  console.error("Uso: calling --slug <negocio> <status|enable|disable> [--sip-host h] [--sip-port p] [--phone-number-id id]");
  process.exit(1);
}
const { DATABASE_URL, DATABASE_APP_URL, ENCRYPTION_KEY } = process.env;
if (!DATABASE_URL || !DATABASE_APP_URL || !ENCRYPTION_KEY) {
  console.error("Faltan DATABASE_URL, DATABASE_APP_URL o ENCRYPTION_KEY en .env");
  process.exit(1);
}

const BACKUP = ".wa-calling-backup.json";
const version = process.env.GRAPH_API_VERSION || "v23.0";
// Siempre el Graph API real (aqui no se usa GRAPH_BASE_URL: apuntaria al WhatsApp falso).
const graph = "https://graph.facebook.com";

const owner = createDb(DATABASE_URL, { max: 1 });
const app = createDb(DATABASE_APP_URL, { max: 2 });
let code = 0;
try {
  const [tenant] = await owner.db.select().from(tenants).where(eq(tenants.slug, slug));
  if (!tenant) throw new Error(`No existe el negocio "${slug}"`);
  const [channel] = await owner.db
    .select()
    .from(channels)
    .where(and(eq(channels.tenantId, tenant.id), eq(channels.type, "whatsapp")));
  if (!channel) throw new Error("El negocio no tiene un canal de WhatsApp");
  const access = await loadChannelAccess(app.db, parseKey(ENCRYPTION_KEY), tenant.id, channel.id);
  if (!access?.accessToken) throw new Error("El canal no tiene la clave de Meta guardada");
  const phoneNumberId = arg("phone-number-id") ?? access.phoneNumberId;
  console.log(`Número (phone_number_id): ${phoneNumberId}${phoneNumberId === access.phoneNumberId ? "  [el conectado al panel]" : ""}`);

  const call = async (method: "GET" | "POST", body?: unknown) => {
    const res = await fetch(`${graph}/${version}/${phoneNumberId}/settings`, {
      method,
      headers: { Authorization: `Bearer ${access.accessToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, ok: res.ok, json };
  };
  const show = (label: string, r: { status: number; json: Record<string, unknown> }) =>
    console.log(`${label} (HTTP ${r.status}):\n${JSON.stringify(r.json, null, 2)}`);

  const current = await call("GET");
  show("Configuración actual de llamadas", current);

  // Requisitos que Meta pide para activar llamadas: limite de mensajeria (2000 o mas), calidad y estado.
  {
    const res = await fetch(`${graph}/${version}/${phoneNumberId}?fields=display_phone_number,quality_rating,messaging_limit_tier,status,name_status,account_mode,throughput`, {
      headers: { Authorization: `Bearer ${access.accessToken}` },
    });
    console.log(`
Estado del número (HTTP ${res.status}):
${JSON.stringify(await res.json().catch(() => ({})), null, 2)}`);
  }

  if (command === "enable") {
    if (!current.ok) throw new Error("No se pudo leer la configuración actual; no se cambia nada.");
    if (!existsSync(BACKUP)) {
      writeFileSync(BACKUP, JSON.stringify({ phoneNumberId, savedAt: new Date().toISOString(), settings: current.json }, null, 2));
      console.log(`\nCopia de seguridad guardada en ${BACKUP}`);
    } else console.log(`\n(Ya existe ${BACKUP}; no se sobrescribe.)`);

    const host = arg("sip-host") ?? "sip.retellai.com";
    const port = Number(arg("sip-port") ?? 5061);
    const body = {
      calling: {
        status: "ENABLED",
        call_icon_visibility: "DEFAULT",
        sip: { status: "ENABLED", servers: [{ hostname: host, port }] },
      },
    };
    const r = await call("POST", body);
    show(`\nActivar llamadas + SIP → ${host}:${port}`, r);
    if (!r.ok) throw new Error("Meta rechazó la configuración (ver arriba). No quedó nada a medias: revisa con `status`.");
    show("\nConfiguración después", await call("GET"));
  }

  if (command === "disable") {
    const r = await call("POST", { calling: { status: "DISABLED", sip: { status: "DISABLED" } } });
    show("\nApagar llamadas y SIP", r);
    if (!r.ok) throw new Error("Meta rechazó la petición (ver arriba).");
    show("\nConfiguración después", await call("GET"));
    if (existsSync(BACKUP)) console.log(`\nLa copia anterior sigue en ${BACKUP} por si quieres comparar.`);
    else console.log("\n(No había copia de seguridad guardada.)");
    void readFileSync;
  }
} catch (error) {
  console.error(`\n✗ ${error instanceof Error ? error.message : error}`);
  code = 1;
} finally {
  await owner.close();
  await app.close();
}
process.exit(code);
