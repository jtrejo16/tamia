import "server-only";
import { createDb, type Database, type DbHandle } from "@empleado/db";
import { createLLMProvider, type LLMProvider } from "@empleado/llm";
import {
  createConnection,
  createEnqueuers,
  createQueues,
  isWorkerAlive,
  publishChange,
  RedisRateLimiter,
  subscribeChanges,
  type Enqueuers,
  type RateLimiter,
} from "@empleado/queue";
import { MercadoPagoClient, RetellClient } from "@empleado/inbox";
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
  mp?: MercadoPagoClient;
  retell?: RetellClient;
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

/** Avisa a los demas paneles abiertos que algo cambio. Nunca falla ni retrasa la respuesta. */
export function notifyChange(): void {
  try {
    void publishChange(getRedis(), prefix()).catch(() => {});
  } catch {
    /* sin Redis no hay tiempo real; queda la consulta periodica */
  }
}

export function subscribeToChanges(onChange: () => void) {
  return subscribeChanges(env("REDIS_URL"), prefix(), onChange);
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

/** Cliente de Mercado Pago, o null si el servidor no tiene su token (entonces no se puede cobrar). */
export function getMercadoPago(): MercadoPagoClient | null {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
  if (!accessToken) return null;
  return (s().mp ??= new MercadoPagoClient({ accessToken, baseUrl: process.env.MERCADOPAGO_BASE_URL || undefined }));
}

/** Direccion publica del panel (para volver de Mercado Pago). */
export function publicBaseUrl(fallback: string): string {
  return (process.env.PUBLIC_BASE_URL?.trim() || fallback).replace(/\/$/, "");
}

/** Cliente de Retell (voz), o null si el servidor no tiene su clave (entonces no hay telefonia con IA). */
export function getRetell(): RetellClient | null {
  const apiKey = process.env.RETELL_API_KEY?.trim();
  if (!apiKey) return null;
  return (s().retell ??= new RetellClient({ apiKey, baseUrl: process.env.RETELL_BASE_URL || undefined }));
}
