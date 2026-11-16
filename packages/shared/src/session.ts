import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Sesion en una cookie firmada (HMAC-SHA256). No guarda secretos: solo quien es el usuario,
 * en que negocio actua y hasta cuando vale. El servidor la verifica en cada peticion.
 */
export type SessionRole = "owner" | "agent" | "viewer";

export interface SessionPayload {
  /** id del usuario */
  uid: string;
  /** id del negocio en el que actua */
  tid: string;
  role: SessionRole;
  /** vencimiento, segundos desde epoch */
  exp: number;
}

export const SESSION_TTL_SECONDS = 12 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

const b64url = (buf: Buffer) => buf.toString("base64url");

function sign(body: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

function assertSecret(secret: string): void {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`AUTH_SECRET debe tener al menos ${MIN_SECRET_LENGTH} caracteres`);
  }
}

export function createSessionToken(
  data: Omit<SessionPayload, "exp">,
  secret: string,
  now: Date = new Date(),
  ttlSeconds = SESSION_TTL_SECONDS,
): string {
  assertSecret(secret);
  const payload: SessionPayload = { ...data, exp: Math.floor(now.getTime() / 1000) + ttlSeconds };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${b64url(sign(body, secret))}`;
}

/** Devuelve la sesion o null si la firma no cuadra, esta mal formada o ya vencio. */
export function verifySessionToken(
  token: string | undefined | null,
  secret: string,
  now: Date = new Date(),
): SessionPayload | null {
  if (!token || token.length > 2048) return null;
  assertSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts as [string, string];

  const expected = sign(body, secret);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<SessionPayload>;
    if (
      typeof payload.uid !== "string" ||
      typeof payload.tid !== "string" ||
      typeof payload.exp !== "number" ||
      (payload.role !== "owner" && payload.role !== "agent" && payload.role !== "viewer")
    ) {
      return null;
    }
    if (payload.exp * 1000 <= now.getTime()) return null;
    return payload as SessionPayload;
  } catch {
    return null;
  }
}
