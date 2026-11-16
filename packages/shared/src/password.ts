import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Hash de contrasenas con scrypt (incluido en Node: sin dependencias nativas).
 * Formato: scrypt$N$r$p$salt(base64)$hash(base64). Los parametros viajan en el hash, asi que
 * se pueden subir despues sin invalidar las contrasenas ya guardadas.
 */
const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
export const MIN_PASSWORD_LENGTH = 10;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const options: ScryptOptions = { N: n, r, p, maxmem: 256 * n * r };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export function assertPasswordStrength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`);
  }
  if (password.length > 200) throw new Error("La contraseña es demasiado larga");
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordStrength(password);
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const params = [Number(n), Number(r), Number(p)];
  if (params.some((v) => !Number.isInteger(v) || v <= 0) || (params[0]! & (params[0]! - 1)) !== 0) return false;
  if (params[0]! > 2 ** 20) return false; // evita que un hash manipulado agote la memoria
  try {
    const expected = Buffer.from(hashB64, "base64");
    const actual = await derive(password.slice(0, 200), Buffer.from(saltB64, "base64"), params[0]!, params[1]!, params[2]!);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;
/**
 * Verifica contra un hash falso cuando el usuario no existe, para que responder "correo
 * desconocido" tarde lo mismo que "contrasena incorrecta" y no se pueda enumerar cuentas.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummy ??= hashPassword("contrasena-falsa-para-igualar-tiempos");
  await verifyPassword(password, await dummy);
  return false;
}
