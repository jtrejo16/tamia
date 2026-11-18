import "server-only";
import type { PageCandidate, SocialDeps } from "@empleado/inbox";
import { decryptJson, encryptJson, parseKey } from "@empleado/shared";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./server";

export const PAGES_COOKIE = "ed_fb_pages";
const STATE_TTL_MS = 10 * 60_000;

/** Datos de la app de Meta, o null si el servidor no los tiene (entonces no se ofrece conectar). */
export function socialDeps(): SocialDeps | null {
  const appId = process.env.META_APP_ID?.trim();
  const appSecret = process.env.META_APP_SECRET?.trim();
  if (!appId || !appSecret) return null;
  return {
    appId,
    appSecret,
    key: parseKey(env("ENCRYPTION_KEY")),
    apiVersion: process.env.GRAPH_API_VERSION || "v23.0",
    baseUrl: process.env.GRAPH_BASE_URL || undefined,
  };
}

const b64 = (b: Buffer) => b.toString("base64url");
// `purpose` separa los state de cada flujo (Facebook, Google...): uno no sirve para completar el otro.
const sign = (data: string, purpose: string) => b64(createHmac("sha256", env("AUTH_SECRET")).update(`${purpose}-state:${data}`).digest());

/** El state va firmado y ligado al usuario y negocio que inicio el flujo: evita que otro "complete" tu conexion (CSRF). */
export function makeState(uid: string, tid: string, purpose = "fb"): string {
  const data = b64(Buffer.from(JSON.stringify({ uid, tid, n: randomBytes(8).toString("hex"), exp: Date.now() + STATE_TTL_MS })));
  return `${data}.${sign(data, purpose)}`;
}

export function verifyState(state: string | null, uid: string, tid: string, purpose = "fb"): boolean {
  if (!state) return false;
  const [data, mac] = state.split(".");
  if (!data || !mac) return false;
  const a = Buffer.from(sign(data, purpose));
  const b = Buffer.from(mac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const p = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as { uid?: string; tid?: string; exp?: number };
    return p.uid === uid && p.tid === tid && typeof p.exp === "number" && p.exp > Date.now();
  } catch {
    return false;
  }
}

/** Las paginas (con sus tokens) esperan la eleccion del usuario en una cookie CIFRADA de 10 min. */
export function sealPages(uid: string, tid: string, pages: PageCandidate[]): string {
  return b64(encryptJson({ uid, tid, pages, exp: Date.now() + STATE_TTL_MS }, parseKey(env("ENCRYPTION_KEY")), `fbpages:${uid}:${tid}`));
}

export function openPages(value: string | undefined, uid: string, tid: string): PageCandidate[] | null {
  if (!value) return null;
  try {
    const p = decryptJson<{ uid: string; tid: string; pages: PageCandidate[]; exp: number }>(
      Buffer.from(value, "base64url"),
      parseKey(env("ENCRYPTION_KEY")),
      `fbpages:${uid}:${tid}`,
    );
    return p.uid === uid && p.tid === tid && p.exp > Date.now() ? p.pages : null;
  } catch {
    return null;
  }
}

export const pagesCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/api/channel/facebook",
  maxAge: 600,
};

// ---------------------------------------------------------------- soporte del operador (conectar en nombre de un cliente)

export const OP_STATE_PURPOSE = "fbop";
export const OP_PAGES_COOKIE = "ed_fb_pages_op";
export const opPagesCookieOptions = { ...pagesCookieOptions, path: "/api/operator/facebook" };

/** State del operador: lleva el negocio al que se conecta. Se firma con otro "proposito" que el de un dueño. */
export function makeOperatorState(operatorId: string, tenantId: string): string {
  const data = b64(Buffer.from(JSON.stringify({ uid: operatorId, tid: tenantId, n: randomBytes(8).toString("hex"), exp: Date.now() + STATE_TTL_MS })));
  return `${data}.${sign(data, OP_STATE_PURPOSE)}`;
}

/** Devuelve el negocio del state si la firma es valida, no vencio y lo creo ESTE operador; si no, null. */
export function readOperatorState(state: string | null, operatorId: string): string | null {
  if (!state) return null;
  const [data, mac] = state.split(".");
  if (!data || !mac) return null;
  const a = Buffer.from(sign(data, OP_STATE_PURPOSE));
  const b = Buffer.from(mac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as { uid?: string; tid?: string; exp?: number };
    return p.uid === operatorId && typeof p.tid === "string" && typeof p.exp === "number" && p.exp > Date.now() ? p.tid : null;
  } catch {
    return null;
  }
}
