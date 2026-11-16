import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Valida la cabecera X-Hub-Signature-256 que Meta firma con el App Secret.
 * Se calcula sobre el cuerpo CRUDO exacto (no sobre el JSON re-serializado).
 */
export function verifySignature(
  rawBody: string | Uint8Array,
  header: string | null | undefined,
  appSecret: string,
): boolean {
  if (!appSecret || !header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  // timingSafeEqual exige el mismo largo; un hex invalido da un buffer mas corto.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Genera la firma (para simuladores y pruebas). */
export function signBody(rawBody: string | Uint8Array, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}
