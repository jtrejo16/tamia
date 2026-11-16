/**
 * Plantillas de WhatsApp de un negocio.
 *
 *   pnpm --filter @empleado/worker templates -- --slug sonrisa list
 *   pnpm --filter @empleado/worker templates -- --slug sonrisa sync     (lee de Meta; no cambia nada alla)
 *   pnpm --filter @empleado/worker templates -- --slug sonrisa create   (CREA en Meta las de recordatorio que falten)
 *
 * Opcional: --waba-id <id> guarda la cuenta de WhatsApp Business del canal antes de operar.
 */
import { channels, createDb, tenants } from "@empleado/db";
import { createReminderTemplates, listTemplates, syncTemplates } from "@empleado/inbox";
import { parseKey } from "@empleado/shared";
import { and, eq } from "drizzle-orm";
import { loadEnv } from "../config";

loadEnv();
const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const command = argv.find((a) => ["list", "sync", "create"].includes(a));
const slug = arg("slug");
if (!slug || !command) {
  console.error("Uso: templates --slug <negocio> <list|sync|create> [--waba-id <id>]");
  process.exit(1);
}
const { DATABASE_URL, DATABASE_APP_URL, ENCRYPTION_KEY } = process.env;
if (!DATABASE_URL || !DATABASE_APP_URL || !ENCRYPTION_KEY) {
  console.error("Faltan DATABASE_URL, DATABASE_APP_URL o ENCRYPTION_KEY en .env");
  process.exit(1);
}

const owner = createDb(DATABASE_URL, { max: 1 }); // solo para buscar el negocio y guardar la cuenta
const app = createDb(DATABASE_APP_URL, { max: 2 }); // las operaciones corren con el rol de la aplicacion
let code = 0;
try {
  const [tenant] = await owner.db.select().from(tenants).where(eq(tenants.slug, slug));
  if (!tenant) throw new Error(`No existe el negocio "${slug}"`);

  const wabaId = arg("waba-id");
  if (wabaId) {
    await owner.db
      .update(channels)
      .set({ wabaId, updatedAt: new Date() })
      .where(and(eq(channels.tenantId, tenant.id), eq(channels.type, "whatsapp")));
    console.log(`Cuenta de WhatsApp Business del canal: ${wabaId}`);
  }

  // Esta herramienta administrativa actua como dueño del negocio.
  const ctx = { tenantId: tenant.id, userId: "00000000-0000-0000-0000-000000000000", role: "owner" as const };
  // Siempre el Graph API real: aqui no se usa GRAPH_BASE_URL (apuntaria al WhatsApp falso).
  const deps = { key: parseKey(ENCRYPTION_KEY), apiVersion: process.env.GRAPH_API_VERSION || "v23.0" };

  if (command === "sync") {
    const r = await syncTemplates(app.db, deps, tenant.id);
    if (!r.ok) throw new Error(`${r.error}${"details" in r && r.details ? `: ${r.details}` : ""}`);
    console.log(`Sincronizado con Meta: ${r.total} plantilla(s), ${r.synced} con cambios.`);
  }
  if (command === "create") {
    const r = await createReminderTemplates(app.db, deps, ctx);
    if (!r.ok) throw new Error(`${r.error}${"details" in r && r.details ? `: ${r.details}` : ""}`);
    console.log(`Creadas en Meta: ${r.created.join(", ") || "(ninguna)"}`);
    console.log(`Ya existían:     ${r.existing.join(", ") || "(ninguna)"}`);
    if (r.created.length) console.log("Meta las revisa (suele tardar de minutos a unas horas). Corre `sync` para ver su estado.");
  }

  const list = await listTemplates(app.db, ctx);
  console.log(`\nPlantillas de ${tenant.name}:`);
  if (list.length === 0) console.log("  (ninguna todavía)");
  for (const t of list) console.log(`  ${t.status.padEnd(9)} ${t.name} [${t.language}] ${t.isReminder ? "· recordatorio" : ""}`);
} catch (error) {
  console.error(`\n✗ ${error instanceof Error ? error.message : error}`);
  code = 1;
} finally {
  await owner.close();
  await app.close();
}
process.exit(code);
