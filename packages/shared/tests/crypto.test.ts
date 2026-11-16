import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptJson,
  decryptSecret,
  encryptJson,
  encryptSecret,
  getEncryptionKey,
  parseKey,
} from "../src/crypto";

const key = randomBytes(32);

describe("cifrado AES-256-GCM", () => {
  it("descifra lo que cifro", () => {
    const blob = encryptSecret("EAAG-token-de-prueba", key);
    expect(decryptSecret(blob, key)).toBe("EAAG-token-de-prueba");
  });

  it("soporta acentos, emojis y texto vacio", () => {
    for (const text of ["Clínica Sonrisa 🦷 ñandú", ""]) {
      expect(decryptSecret(encryptSecret(text, key), key)).toBe(text);
    }
  });

  it("el texto en claro no aparece en el blob", () => {
    const blob = encryptSecret("super-secreto-visible", key);
    expect(blob.toString("utf8")).not.toContain("super-secreto-visible");
  });

  it("cada cifrado usa un IV distinto (mismo texto, distinto blob)", () => {
    const a = encryptSecret("igual", key);
    const b = encryptSecret("igual", key);
    expect(a.equals(b)).toBe(false);
  });

  it("falla con una llave distinta", () => {
    const blob = encryptSecret("dato", key);
    expect(() => decryptSecret(blob, randomBytes(32))).toThrow(/No se pudo descifrar/);
  });

  it("detecta un dato alterado (un solo bit)", () => {
    const blob = encryptSecret("dato importante", key);
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 1;
    expect(() => decryptSecret(blob, key)).toThrow(/No se pudo descifrar/);
  });

  it("ligado a un contexto: un blob copiado a otro tenant no se descifra", () => {
    const blob = encryptSecret("token", key, "tenant-A");
    expect(decryptSecret(blob, key, "tenant-A")).toBe("token");
    expect(() => decryptSecret(blob, key, "tenant-B")).toThrow(/No se pudo descifrar/);
    expect(() => decryptSecret(blob, key)).toThrow(/No se pudo descifrar/);
  });

  it("rechaza blobs truncados o de version desconocida", () => {
    expect(() => decryptSecret(Buffer.from([1, 2, 3]), key)).toThrow(/invalido/);
    const blob = encryptSecret("x", key);
    blob[0] = 99;
    expect(() => decryptSecret(blob, key)).toThrow(/Version/);
  });

  it("cifra y descifra objetos JSON", () => {
    const creds = { refresh_token: "1//abc", scope: ["calendar"] };
    expect(decryptJson(encryptJson(creds, key, "t1"), key, "t1")).toEqual(creds);
  });
});

describe("manejo de la llave", () => {
  it("acepta 32 bytes en base64 y rechaza otros largos", () => {
    expect(parseKey(randomBytes(32).toString("base64"))).toHaveLength(32);
    expect(() => parseKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => parseKey("corta")).toThrow(/32 bytes/);
  });

  it("getEncryptionKey exige la variable", () => {
    expect(() => getEncryptionKey({})).toThrow(/ENCRYPTION_KEY/);
    expect(getEncryptionKey({ ENCRYPTION_KEY: key.toString("base64") })).toEqual(key);
  });
});
