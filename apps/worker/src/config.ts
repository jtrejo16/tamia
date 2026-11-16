import { parseKey } from "@empleado/shared";

/** Carga el .env de la raiz del repo (pnpm ejecuta con cwd = apps/worker). */
export function loadEnv(): void {
  for (const path of ["../../.env", ".env"]) {
    try {
      process.loadEnvFile(path);
      return;
    } catch {
      /* siguiente */
    }
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name} (revisa tu archivo .env)`);
  return v;
}

export interface WorkerConfig {
  databaseAppUrl: string;
  redisUrl: string;
  encryptionKey: Buffer;
  queuePrefix: string;
  graphApiVersion: string;
  /** Para desarrollo: apunta a un Graph API falso en vez de graph.facebook.com. */
  graphBaseUrl?: string;
  openRouterApiKey: string;
  llmMode?: string;
  webhookPort: number;
}

export function loadConfig(): WorkerConfig {
  return {
    databaseAppUrl: required("DATABASE_APP_URL"),
    redisUrl: required("REDIS_URL"),
    encryptionKey: parseKey(required("ENCRYPTION_KEY")),
    queuePrefix: process.env.QUEUE_PREFIX || "empleado",
    graphApiVersion: process.env.GRAPH_API_VERSION || "v23.0",
    graphBaseUrl: process.env.GRAPH_BASE_URL || undefined,
    openRouterApiKey: required("OPENROUTER_API_KEY"),
    llmMode: process.env.LLM_MODE,
    webhookPort: Number(process.env.WEBHOOK_PORT || 3001),
  };
}

export type Logger = (event: string, data?: Record<string, unknown>) => void;

/** Una linea JSON por evento: facil de leer hoy y de enviar a un agregador de logs despues. */
export const consoleLogger: Logger = (event, data) => {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
};
