import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, loadPack, type PromptInput } from "../src";

/**
 * "Fotografia" del prompt completo de un negocio de citas. Protege que abrir el prompt por modulos NO cambie ni una
 * letra para los giros actuales. Si cambias el prompt A PROPOSITO, borra el archivo de tests/golden y vuelve a correr.
 */
const dir = join(dirname(fileURLToPath(import.meta.url)), "golden");

const tenant = {
  id: "t1",
  name: "Clínica Dental Sonrisa",
  slug: "sonrisa",
  vertical: "dental",
  timezone: "America/Merida",
  locale: "es-MX",
  plan: "basic",
  status: "active",
  privacyNoticeUrl: "https://example.test/privacidad",
  profile: {
    description: "clínica dental familiar en Mérida",
    address: "Calle 60 #500, Mérida",
    mapsUrl: "https://maps.example/x",
    paymentMethods: ["efectivo", "tarjeta"],
    keyFacts: ["Estacionamiento gratis."],
    cancellationPolicy: "Avisar con 12 horas.",
    depositPolicy: "Sin anticipo.",
    cancellationNoticeHours: 12,
  },
  humanHours: { mon: ["09:00", "18:00"], tue: ["09:00", "18:00"], sat: null },
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const config = {
  id: "c1",
  tenantId: "t1",
  assistantName: "Sofía",
  tone: "cálido y profesional",
  formality: "usted",
  model: "x/y",
  fallbackModel: null,
  temperature: 0.3,
  autonomy: "copilot",
  escalationRules: ["Pagos con tarjeta"],
  forbiddenTopics: ["política"],
  packSlug: "dental",
  packVersion: "1",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function input(mode: "live" | "dry"): PromptInput {
  return {
    tenant: tenant as never,
    config: config as never,
    pack: loadPack("dental"),
    now: new Date("2027-03-01T18:00:00Z"),
    mode,
    contactMemory: "nombre: Ana; teléfono: +529991112233 (ya lo tienes, no lo pidas)",
    conversationSummary: "Pidió una limpieza.",
    taskStateJson: "{}",
    upcomingAppointments: "abc | Limpieza dental con Dra. Ruiz | martes 2 de marzo, 10:00 | confirmed",
    fewShot: "Cliente: hola\nAsistente: ¡Hola!",
  };
}

describe("prompt de un negocio de citas (no debe cambiar)", () => {
  for (const mode of ["live", "dry"] as const) {
    it(`modo ${mode}: sale igual que la fotografia guardada`, () => {
      const file = join(dir, `prompt-citas-${mode}.txt`);
      const actual = buildSystemPrompt(input(mode));
      if (!existsSync(file)) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, actual, "utf8");
      }
      expect(actual).toBe(readFileSync(file, "utf8").split("\r\n").join("\n"));
    });
  }
});
