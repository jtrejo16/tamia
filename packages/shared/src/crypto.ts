import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Cifrado de credenciales de terceros (tokens de WhatsApp, OAuth de Google) en reposo.
 * AES-256-GCM con IV aleatorio por mensaje.
 *
 * Formato del blob: [version 1B][iv 12B][tag 16B][texto cifrado ...]
 * El byte de version permite rotar el algoritmo o la llave sin romper lo ya guardado.
 */

const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 1 + IV_LENGTH + TAG_LENGTH;

/** Convierte la llave en base64 (variable ENCRYPTION_KEY) a 32 bytes. */
export function parseKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY debe ser de 32 bytes en base64. Genera una con: " +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return key;
}

export function getEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.ENCRYPTION_KEY;
  if (!raw) throw new Error("Falta la variable de entorno ENCRYPTION_KEY");
  return parseKey(raw);
}

/**
 * Cifra un texto. `aad` (datos autenticados adicionales) liga el cifrado a un contexto,
 * por ejemplo el tenant_id: un blob copiado a otro negocio ya no se puede descifrar.
 */
export function encryptSecret(plaintext: string, key: Buffer, aad?: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), encrypted]);
}

export function decryptSecret(blob: Buffer, key: Buffer, aad?: string): string {
  if (blob.length < HEADER_LENGTH) throw new Error("Dato cifrado invalido");
  if (blob[0] !== VERSION) throw new Error("Version de cifrado no soportada");
  const iv = blob.subarray(1, 1 + IV_LENGTH);
  const tag = blob.subarray(1 + IV_LENGTH, HEADER_LENGTH);
  const encrypted = blob.subarray(HEADER_LENGTH);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
    if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    // Mensaje generico a proposito: no revelar si fallo la llave, el contexto o el contenido.
    throw new Error("No se pudo descifrar: llave o contexto incorrectos, o dato alterado");
  }
}

/** Atajo para guardar objetos (credenciales de Google, etc.). */
export function encryptJson(value: unknown, key: Buffer, aad?: string): Buffer {
  return encryptSecret(JSON.stringify(value), key, aad);
}

export function decryptJson<T>(blob: Buffer, key: Buffer, aad?: string): T {
  return JSON.parse(decryptSecret(blob, key, aad)) as T;
}
