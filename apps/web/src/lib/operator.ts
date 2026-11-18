import "server-only";
import type { TemplateGraphDeps } from "@empleado/inbox";
import { parseKey } from "@empleado/shared";
import { googleDeps } from "./google";
import { socialDeps } from "./facebook";
import { env, getMercadoPago, getRetell, llmMode, workerAlive } from "./server";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function graphDeps(): TemplateGraphDeps {
  return {
    key: parseKey(env("ENCRYPTION_KEY")),
    apiVersion: process.env.GRAPH_API_VERSION || "v23.0",
    baseUrl: process.env.GRAPH_BASE_URL || undefined,
  };
}

export interface PlatformStatus {
  worker: boolean;
  llmMode: "free" | "paid";
  publicBaseUrl: string | null;
  /** Que servicios externos tienen sus claves en el servidor (nunca los valores). */
  services: { mercadopago: boolean; retell: boolean; meta: boolean; google: boolean; openrouter: boolean };
}

/** Estado del propio servicio: el worker (envios y recordatorios) y que claves estan puestas. */
export async function platformStatus(): Promise<PlatformStatus> {
  return {
    worker: await workerAlive(),
    llmMode: llmMode(),
    publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim() || null,
    services: {
      mercadopago: getMercadoPago() !== null,
      retell: getRetell() !== null,
      meta: socialDeps() !== null,
      google: googleDeps() !== null,
      openrouter: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
    },
  };
}
