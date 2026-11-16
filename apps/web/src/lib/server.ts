import "server-only";
import { createDb, type Database, type DbHandle } from "@empleado/db";
import { createLLMProvider, type LLMProvider } from "@empleado/llm";
import {
  createConnection,
  createEnqueuers,
  createQueues,
  isWorkerAlive,
  RedisRateLimiter,
  type Enqueuers,
  type RateLimiter,
} from "@empleado/queue";
import type { Redis } from "ioredis";

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name} (revisa el archivo .env de la raiz)`);
  return v;
}

/** Conexiones compartidas: sobreviven a las recargas en caliente de `next dev`. */
interface Singletons {
  db?: DbHandle;
  redis?: Redis;
  enqueue?: Enqueuers;
  limiter?: RateLimiter;
  llm?: LLMProvider;
}
const g = globalThis as unknown as { __empleado?: Singletons };
const s = (): Singletons => (g.__empleado ??= {});

/** Base de datos con el rol de la APLICACION (RLS aplica). */
export function getDb(): Database {
  return (s().db ??= createDb(env("DATABASE_APP_URL"), { max: 10 })).db;
}

const prefix = () => process.env.QUEUE_PREFIX || "empleado";

function getRedis(): Redis {
  return (s().redis ??= createConnection(env("REDIS_URL")));
}

/** true si el worker dio senales de vida hace poco. Si Redis falla, se asume que no. */
export async function workerAlive(): Promise<boolean> {
  try {
    return await isWorkerAlive(getRedis(), prefix());
  } catch {
    return false;
  }
}

export function getEnqueue(): Enqueuers {
  return (s().enqueue ??= createEnqueuers(createQueues(getRedis(), prefix())));
}

export function getLimiter(): RateLimiter {
  return (s().limiter ??= new RedisRateLimiter(getRedis(), prefix()));
}

export function getLLM(): LLMProvider {
  return (s().llm ??= createLLMProvider({
    apiKey: env("OPENROUTER_API_KEY"),
    mode: process.env.LLM_MODE,
    appName: "Empleado Digital (panel)",
  }));
}

export const llmMode = (): "free" | "paid" => (process.env.LLM_MODE?.trim().toLowerCase() === "free" ? "free" : "paid");
