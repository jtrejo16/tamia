import "server-only";
import type { GoogleDeps } from "@empleado/inbox";
import { parseKey } from "@empleado/shared";
import { env } from "./server";

/** Datos de la app de Google, o null si el servidor no los tiene (entonces no se ofrece conectar el calendario). */
export function googleDeps(): GoogleDeps | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, key: parseKey(env("ENCRYPTION_KEY")) };
}

export const GOOGLE_STATE_PURPOSE = "gcal";
