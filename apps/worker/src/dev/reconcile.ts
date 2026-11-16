/**
 * Concilia AHORA las suscripciones con Mercado Pago (la misma tarea que el worker corre cada 15 minutos).
 *
 *   pnpm billing:reconcile [-- --all]      --all ignora el descanso de 1 h y revisa todas
 */
import { createDb } from "@empleado/db";
import { MercadoPagoClient, reconcileSubscriptions } from "@empleado/inbox";
import { consoleLogger, loadEnv } from "../config";

loadEnv();
const { DATABASE_APP_URL, MERCADOPAGO_ACCESS_TOKEN } = process.env;
if (!DATABASE_APP_URL || !MERCADOPAGO_ACCESS_TOKEN) {
  console.error("Faltan DATABASE_APP_URL o MERCADOPAGO_ACCESS_TOKEN en .env");
  process.exit(1);
}
const all = process.argv.includes("--all");
const app = createDb(DATABASE_APP_URL, { max: 2 });
let code = 0;
try {
  const mp = new MercadoPagoClient({ accessToken: MERCADOPAGO_ACCESS_TOKEN, baseUrl: process.env.MERCADOPAGO_BASE_URL || undefined });
  const r = await reconcileSubscriptions(app.db, mp, { everyMinutes: all ? 0 : 60, log: consoleLogger });
  console.log(`Conciliación: ${r.checked} revisada(s), ${r.changed} con cambios, ${r.errors} con error.`);
} catch (error) {
  console.error(`\n✗ ${error instanceof Error ? error.message : error}`);
  code = 1;
} finally {
  await app.close();
}
process.exit(code);
