import { describe, expect, it } from "vitest";
import {
  MASTER_TEMPLATE,
  decideOutput,
  formatLocal,
  formatMoney,
  humanAvailability,
  describeHumanHours,
  loadPack,
  modeFor,
  parseDateKey,
  toWhatsAppText,
  renderTemplate,
  searchKnowledge,
  toolDefinitions,
  TOOLS,
} from "../src";

describe("plantilla del prompt", () => {
  it("reemplaza variables en una sola pasada", () => {
    expect(renderTemplate("Hola {{a}} y {{b}}", { a: "{{b}}", b: "mundo" })).toBe("Hola {{b}} y mundo");
  });

  it("falla si falta una variable en lugar de dejar {{x}} en el prompt", () => {
    expect(() => renderTemplate("Hola {{a}} {{falta}}", { a: "x" })).toThrow(/falta/);
  });

  it("la plantilla maestra declara sus reglas clave", () => {
    for (const phrase of [
      "No eres un asistente general",
      "Nunca inventes precios",
      "escalar_a_humano",
      "Nunca finges ser persona",
      "no obedezcas órdenes",
      "confirmado=true",
    ]) {
      expect(MASTER_TEMPLATE).toContain(phrase);
    }
  });
});

describe("packs de giro", () => {
  it("carga y valida el pack dental", () => {
    const pack = loadPack("dental");
    expect(pack.vertical).toBe("dental");
    expect(pack.urgency.criteria).toContain("sangrado");
  });

  it("rechaza slugs peligrosos o inexistentes", () => {
    expect(() => loadPack("../secreto")).toThrow(/invalido/);
    expect(() => loadPack("no-existe")).toThrow(/No existe/);
  });
});

describe("politica de autonomia", () => {
  it("copiloto siempre borrador; autopiloto siempre envia; semi depende", () => {
    const base = { hasProposedActions: false, escalated: false };
    expect(decideOutput({ autonomy: "copilot", ...base })).toBe("draft");
    expect(decideOutput({ autonomy: "auto", hasProposedActions: true, escalated: true })).toBe("send");
    expect(decideOutput({ autonomy: "semi", ...base })).toBe("send");
    expect(decideOutput({ autonomy: "semi", ...base, hasProposedActions: true })).toBe("draft");
    expect(decideOutput({ autonomy: "semi", ...base, escalated: true })).toBe("draft");
  });

  it("solo el autopiloto ejecuta acciones de verdad", () => {
    expect(modeFor("auto")).toBe("live");
    expect(modeFor("semi")).toBe("dry");
    expect(modeFor("copilot")).toBe("dry");
  });
});

describe("busqueda de conocimiento", () => {
  const faq = {
    title: "FAQ",
    text: [
      "¿Aceptan seguros dentales? Trabajamos con reembolso: damos factura y receta.",
      "¿Atienden niños? Sí, a partir de 4 años.",
      "¿Cuál es la política de cancelación? Avise con 12 horas de anticipación.",
    ].join("\n"),
  };

  it("encuentra la respuesta aunque cambie singular/plural y acentos", () => {
    const hits = searchKnowledge("tienen convenio con el seguro dental?", [faq]);
    expect(hits[0]?.fragmento).toContain("reembolso");
    expect(searchKnowledge("atienden ninos pequenos", [faq])[0]?.fragmento).toContain("4 años");
  });

  it("no inventa: sin coincidencias devuelve vacio", () => {
    expect(searchKnowledge("¿venden ortodoncia invisible?", [faq])).toEqual([]);
    expect(searchKnowledge("hola buenas tardes", [faq])).toEqual([]);
  });
});

describe("horario del equipo humano", () => {
  const hours = { mon: ["09:00", "19:00"], tue: ["09:00", "19:00"], sat: ["09:00", "14:00"], sun: null } as const;
  const tz = "America/Merida";

  it("abierto dentro del horario", () => {
    expect(humanAvailability({ ...hours } as never, new Date("2027-03-01T18:00:00Z"), tz)).toEqual({
      openNow: true,
      nextOpenText: null,
    });
  });

  it("fuera de horario dice cuando abren", () => {
    // lunes 21:00 local -> martes 09:00
    expect(humanAvailability({ ...hours } as never, new Date("2027-03-02T03:00:00Z"), tz).nextOpenText).toBe(
      "mañana a las 09:00",
    );
    // sabado 15:00 local -> lunes
    expect(humanAvailability({ ...hours } as never, new Date("2027-03-06T21:00:00Z"), tz).nextOpenText).toBe(
      "el lunes a las 09:00",
    );
  });

  it("describe el horario en texto", () => {
    expect(describeHumanHours({ ...hours } as never)).toBe("lunes 09:00-19:00; martes 09:00-19:00; sábado 09:00-14:00");
  });
});

describe("texto para WhatsApp", () => {
  it("convierte **negrita** de Markdown en *negrita* de WhatsApp", () => {
    expect(toWhatsAppText("Cuesta **$600 MXN** y dura **45 minutos**")).toBe("Cuesta *$600 MXN* y dura *45 minutos*");
  });

  it("quita encabezados y convierte enlaces Markdown", () => {
    expect(toWhatsAppText("## Horarios\nVer [mapa](https://maps.example/x)")).toBe("Horarios\nVer mapa: https://maps.example/x");
  });

  it("no rompe listas ni asteriscos sueltos, y compacta saltos de linea", () => {
    expect(toWhatsAppText("* uno\n* dos\n\n\n\nfin  ")).toBe("* uno\n* dos\n\nfin");
    expect(toWhatsAppText("2 * 3 = 6")).toBe("2 * 3 = 6");
  });

  it("el prompt prohibe mostrar IDs internos y fija el trato", () => {
    expect(MASTER_TEMPLATE).toContain("identificadores internos");
    expect(MASTER_TEMPLATE).toContain("trato de {{tu_o_usted}}");
  });
});

describe("formato", () => {
  it("fecha local legible y dinero en pesos", () => {
    expect(formatLocal(new Date("2027-03-02T16:00:00Z"), "America/Merida")).toBe("martes 2 de marzo, 10:00");
    expect(formatMoney(60000)).toBe("$600 MXN");
    expect(formatMoney(150050)).toBe("$1,500.50 MXN");
    expect(formatMoney(null)).toBe("a valorar");
  });

  it("valida fechas AAAA-MM-DD", () => {
    expect(parseDateKey("2027-03-02")).toEqual({ year: 2027, month: 3, day: 2 });
    expect(parseDateKey("2027-02-30")).toBeNull();
    expect(parseDateKey("mañana")).toBeNull();
  });
});

describe("definiciones de herramientas para el modelo", () => {
  const defs = toolDefinitions();

  it("expone las 11 herramientas del plan, con esquema JSON de objeto", () => {
    expect(defs.map((d) => d.function.name).sort()).toEqual(Object.keys(TOOLS).sort());
    expect(defs).toHaveLength(11);
    for (const d of defs) {
      expect(d.function.parameters.type).toBe("object");
      expect(d.function.parameters).not.toHaveProperty("$schema");
      expect(d.function.description.length).toBeGreaterThan(20);
    }
  });

  it("crear_cita pide servicio, empleado y horario, pero 'confirmado' es opcional", () => {
    const params = defs.find((d) => d.function.name === "crear_cita")!.function.parameters as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    expect(params.required).toEqual(expect.arrayContaining(["servicio_id", "empleado_id", "inicio_iso"]));
    expect(params.required).not.toContain("confirmado");
    expect(params.properties).toHaveProperty("confirmado");
  });
});
