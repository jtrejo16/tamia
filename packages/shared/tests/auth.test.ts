import { describe, expect, it } from "vitest";
import {
  assertPasswordStrength,
  createSessionToken,
  hashPassword,
  verifyAgainstDummy,
  verifyPassword,
  verifySessionToken,
} from "../src";

const SECRET = "un-secreto-largo-de-al-menos-32-caracteres!!";
const NOW = new Date("2027-03-01T12:00:00Z");
const data = { uid: "u1", tid: "t1", role: "owner" as const };

describe("contraseñas (scrypt)", () => {
  it("verifica la correcta y rechaza las demás", async () => {
    const hash = await hashPassword("Contraseña-segura-123");
    expect(await verifyPassword("Contraseña-segura-123", hash)).toBe(true);
    expect(await verifyPassword("contraseña-segura-123", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("cada hash lleva una sal distinta y no contiene la contraseña", async () => {
    const a = await hashPassword("la-misma-contraseña");
    const b = await hashPassword("la-misma-contraseña");
    expect(a).not.toBe(b);
    expect(a).not.toContain("la-misma-contraseña");
    expect(a.startsWith("scrypt$32768$8$1$")).toBe(true);
  });

  it("tolera hashes ausentes, mal formados o manipulados sin lanzar", async () => {
    expect(await verifyPassword("x", null)).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$algo")).toBe(false);
    expect(await verifyPassword("x", "scrypt$3$8$1$c2Fs$aGFzaA==")).toBe(false); // N no es potencia de 2
    expect(await verifyPassword("x", "scrypt$99999999999$8$1$c2Fs$aGFzaA==")).toBe(false); // memoria absurda
  });

  it("normaliza Unicode: la misma 'ñ' escrita de dos formas es la misma contraseña", async () => {
    const hash = await hashPassword("contraseña-ñandú-2027");
    expect(await verifyPassword("contraseña-ñandú-2027".normalize("NFD"), hash)).toBe(true);
  });

  it("exige una longitud minima", async () => {
    expect(() => assertPasswordStrength("corta")).toThrow(/al menos 10/);
    await expect(hashPassword("corta")).rejects.toThrow();
  });

  it("verifyAgainstDummy siempre devuelve false (pero gasta el mismo tiempo)", async () => {
    expect(await verifyAgainstDummy("cualquier-cosa")).toBe(false);
  });
});

describe("sesion firmada", () => {
  it("acepta un token valido y devuelve a quien es", () => {
    const token = createSessionToken(data, SECRET, NOW);
    expect(verifySessionToken(token, SECRET, NOW)).toMatchObject({ uid: "u1", tid: "t1", role: "owner" });
  });

  it("vence a las 12 horas", () => {
    const token = createSessionToken(data, SECRET, NOW);
    expect(verifySessionToken(token, SECRET, new Date(NOW.getTime() + 11 * 3600_000))).not.toBeNull();
    expect(verifySessionToken(token, SECRET, new Date(NOW.getTime() + 12 * 3600_000 + 1000))).toBeNull();
  });

  it("rechaza un token con la firma de otro secreto", () => {
    const token = createSessionToken(data, "otro-secreto-largo-de-al-menos-32-caracteres", NOW);
    expect(verifySessionToken(token, SECRET, NOW)).toBeNull();
  });

  it("rechaza si se altera el contenido (por ejemplo, subirse a otro negocio o a 'owner')", () => {
    const token = createSessionToken({ ...data, role: "viewer" }, SECRET, NOW);
    const [, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: "u1", tid: "OTRO", role: "owner", exp: 9_999_999_999 })).toString("base64url");
    expect(verifySessionToken(`${forged}.${signature}`, SECRET, NOW)).toBeNull();
  });

  it("rechaza basura: vacio, sin firma, partes de mas, firma truncada", () => {
    const token = createSessionToken(data, SECRET, NOW);
    for (const bad of [undefined, null, "", "abc", "a.b.c", `${token}x`, token.slice(0, -4), "x".repeat(5000)]) {
      expect(verifySessionToken(bad, SECRET, NOW)).toBeNull();
    }
  });

  it("rechaza roles inventados", () => {
    const token = createSessionToken({ ...data, role: "superadmin" as never }, SECRET, NOW);
    expect(verifySessionToken(token, SECRET, NOW)).toBeNull();
  });

  it("exige un secreto largo", () => {
    expect(() => createSessionToken(data, "corto", NOW)).toThrow(/AUTH_SECRET/);
    expect(() => verifySessionToken("a.b", "corto", NOW)).toThrow(/AUTH_SECRET/);
  });
});
