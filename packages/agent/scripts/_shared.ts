import { agentConfigs, createDb, tenants, type DbHandle } from "@empleado/db";
import { createLLMProvider, FREE_MODELS, parseLlmMode, type LLMProvider } from "@empleado/llm";
import { eq } from "drizzle-orm";

for (const path of ["../../.env", ".env"]) {
  try {
    process.loadEnvFile(path);
    break;
  } catch {
    /* probar el siguiente */
  }
}

export function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Falta ${name} en el archivo .env`);
    process.exit(1);
  }
  return v;
}

export interface Dbs {
  owner: DbHandle;
  app: DbHandle;
}

export function openDbs(): Dbs {
  return {
    // Solo para buscar el negocio por slug y ajustar su configuracion (herramienta de desarrollo).
    owner: createDb(env("DATABASE_URL"), { max: 1 }),
    // El agente SIEMPRE corre con el rol de la aplicacion: RLS aplica.
    app: createDb(env("DATABASE_APP_URL"), { max: 4 }),
  };
}

/** Proveedor de IA segun LLM_MODE del .env ("free" = solo modelos gratuitos, para pruebas). */
export function provider(): LLMProvider {
  return createLLMProvider({
    apiKey: env("OPENROUTER_API_KEY"),
    mode: process.env.LLM_MODE,
    appName: "Empleado Digital (desarrollo)",
  });
}

/** Linea para mostrar al iniciar, para no confundir modelos gratis con de pago. */
export function modeBanner(): string {
  if (parseLlmMode(process.env.LLM_MODE) === "free") {
    return `Modelos GRATUITOS (${FREE_MODELS.primary}, respaldo ${FREE_MODELS.fallback}). Solo datos de prueba: los proveedores gratuitos pueden registrar los mensajes.`;
  }
  return "Modelos de pago según el nivel configurado del negocio.";
}

export async function findTenant(dbs: Dbs, slug: string) {
  const [tenant] = await dbs.owner.db.select().from(tenants).where(eq(tenants.slug, slug));
  if (!tenant) {
    console.error(`No existe el negocio "${slug}". Corre primero: pnpm db:seed`);
    process.exit(1);
  }
  return tenant;
}

export async function setAutonomy(dbs: Dbs, tenantId: string, autonomy: "copilot" | "semi" | "auto") {
  await dbs.owner.db.update(agentConfigs).set({ autonomy }).where(eq(agentConfigs.tenantId, tenantId));
}

export const money = (usd: number) => `US$${usd.toFixed(5)}`;

export function showTools(trace: Array<{ name: string; result: Record<string, unknown> }>) {
  for (const t of trace) {
    const brief = JSON.stringify(t.result);
    console.log(`   · ${t.name} → ${brief.length > 150 ? brief.slice(0, 150) + "…" : brief}`);
  }
}
