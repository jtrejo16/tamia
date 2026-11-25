import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  GENERIC_PACK,
  TOOLS,
  buildSystemPrompt,
  defineModuleTool,
  isMutating,
  registerModulePrompt,
  registerModuleTools,
  runTool,
  toolDefinitions,
  type PromptInput,
  type TurnContext,
} from "../src";

const names = (modules?: readonly string[]) => toolDefinitions(modules).map((t) => t.function.name);
const CITAS = ["consultar_servicios", "buscar_disponibilidad", "crear_cita", "buscar_citas_del_contacto", "reprogramar_cita", "cancelar_cita"];
const NUCLEO = ["consultar_horario", "guardar_datos_contacto", "buscar_conocimiento", "enviar_ubicacion", "escalar_a_humano"];

// Un negocio con los modulos que se indiquen (por profile.modules). runTool solo mira ctx.tenant antes de ejecutar un modulo.
const ctxOf = (modules?: string[], vertical = "dental") => ({ tenant: { vertical, profile: modules ? { modules } : {} } }) as unknown as TurnContext;

afterAll(() => {
  // Deja el registro como estaba: nadie mas en este archivo debe ver el modulo de prueba.
  registerModuleTools("restaurante", []);
  registerModulePrompt("restaurante", {});
});

describe("herramientas por modulo", () => {
  it("sin indicar modulos (un negocio de citas) salen las mismas 11 herramientas de siempre, en el mismo orden", () => {
    expect(names()).toEqual(Object.keys(TOOLS));
    expect(names(["citas"])).toEqual(Object.keys(TOOLS));
    expect(names()).toHaveLength(11);
  });

  it("sin el modulo de citas quedan solo las del nucleo", () => {
    expect(names([])).toEqual(NUCLEO);
    expect(names(["restaurante"])).toEqual(NUCLEO); // restaurante todavia no aporta herramientas
    for (const n of CITAS) expect(names([])).not.toContain(n);
  });

  it("un negocio sin citas no puede ni usarlas aunque el modelo las pida", async () => {
    const run = await runTool("crear_cita", JSON.stringify({ servicio_id: "x" }), ctxOf([]));
    expect(run.result).toMatchObject({ error: "herramienta_desconocida", disponibles: NUCLEO });
  });

  it("una herramienta que no existe sigue dando herramienta_desconocida con la lista de las disponibles", async () => {
    expect((await runTool("no_existe", "{}", ctxOf())).result).toMatchObject({ error: "herramienta_desconocida", disponibles: Object.keys(TOOLS) });
    // Los nombres heredados de Object no cuentan como herramientas.
    expect((await runTool("constructor", "{}", ctxOf())).result).toMatchObject({ error: "herramienta_desconocida" });
  });

  it("un modulo nuevo aporta sus herramientas, solo a los negocios que lo tienen", async () => {
    const execute = vi.fn(async (args: { platillo: string }) => ({ ok: true, platillo: args.platillo }));
    registerModuleTools("restaurante", [
      defineModuleTool({
        name: "consultar_menu_prueba",
        description: "Consulta el menu",
        mutating: false,
        schema: z.object({ platillo: z.string().min(2) }),
        execute,
      }),
      defineModuleTool({ name: "crear_pedido_prueba", description: "Crea un pedido", mutating: true, schema: z.object({}), execute: async () => ({ ok: true }) }),
    ]);

    // Los negocios de citas no la ven ni la pueden usar.
    expect(names()).toEqual(Object.keys(TOOLS));
    expect((await runTool("consultar_menu_prueba", JSON.stringify({ platillo: "taco" }), ctxOf())).result).toMatchObject({ error: "herramienta_desconocida" });
    expect(execute).not.toHaveBeenCalled();

    // Un negocio con el modulo: aparece en la lista del modelo (con su esquema), despues de las del nucleo, y se ejecuta.
    const withIt = toolDefinitions(["restaurante"]);
    expect(withIt.map((t) => t.function.name)).toEqual([...NUCLEO, "consultar_menu_prueba", "crear_pedido_prueba"]);
    expect(withIt.find((t) => t.function.name === "consultar_menu_prueba")!.function.parameters).toMatchObject({ type: "object", required: ["platillo"] });
    const ok = await runTool("consultar_menu_prueba", JSON.stringify({ platillo: "taco" }), ctxOf(["restaurante"]));
    expect(ok.result).toEqual({ ok: true, platillo: "taco" });

    // Valida argumentos y no deja escapar errores.
    expect((await runTool("consultar_menu_prueba", JSON.stringify({ platillo: "x" }), ctxOf(["restaurante"]))).result).toMatchObject({ error: "argumentos_invalidos" });
    expect((await runTool("consultar_menu_prueba", "no es json", ctxOf(["restaurante"]))).result).toMatchObject({ error: "argumentos_invalidos" });
    execute.mockRejectedValueOnce(new Error("se cayo"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await runTool("consultar_menu_prueba", JSON.stringify({ platillo: "taco" }), ctxOf(["restaurante"]))).result).toMatchObject({ error: "error_interno" });
    quiet.mockRestore();

    // Si modifica datos, pasa por la politica de aprobacion como las citas.
    expect(isMutating("crear_pedido_prueba")).toBe(true);
    expect(isMutating("consultar_menu_prueba")).toBe(false);
    expect(isMutating("crear_cita")).toBe(true);
    expect(isMutating("nada")).toBe(false);
  });
});

describe("prompt por modulo", () => {
  const input = (modules?: string[]): PromptInput => ({
    tenant: { name: "Negocio X", vertical: "dental", timezone: "America/Merida", locale: "es-MX", privacyNoticeUrl: null, humanHours: {}, profile: {} } as never,
    config: { assistantName: "Ana", tone: "amable", formality: "usted", escalationRules: [], forbiddenTopics: [] } as never,
    pack: GENERIC_PACK,
    now: new Date("2027-03-01T18:00:00Z"),
    mode: "live",
    contactMemory: "",
    conversationSummary: "",
    taskStateJson: "{}",
    upcomingAppointments: "",
    ...(modules ? { modules } : {}),
  });

  it("un negocio sin citas no recibe el flujo de agendar ni sus reglas", () => {
    const p = buildSystemPrompt(input([]));
    for (const gone of ["AGENDAR CITAS", "Citas próximas", "CITAS DEL CLIENTE", "buscar_disponibilidad", "Agendar, cambiar y cancelar citas", "Una cita solo existe"]) expect(p).not.toContain(gone);
    for (const kept of ["ESCALA A UN HUMANO SIEMPRE QUE", "REGLAS DE VERDAD", "4. No des diagnósticos", "DATOS FIJOS DEL NEGOCIO", "Tarea en curso"]) expect(p).toContain(kept);
    expect(p).not.toContain("\n\n\n"); // sin huecos feos donde estaban los bloques del modulo
  });

  it("por defecto, un negocio de citas sigue recibiendo todo (el detalle exacto lo cuida prompt-golden)", () => {
    const p = buildSystemPrompt(input());
    for (const kept of ["AGENDAR CITAS", "- Citas próximas:", "CITAS DEL CLIENTE", "5. Una cita solo existe", "- Agendar, cambiar y cancelar citas"]) expect(p).toContain(kept);
  });

  it("un modulo nuevo agrega sus secciones; las reglas se numeran a continuacion de las del nucleo", () => {
    registerModulePrompt("restaurante", {
      tasks: ["- Tomar pedidos de {{nombre_negocio}}."],
      truthRules: ["Un pedido solo existe si una herramienta lo confirmó.", "Nunca inventes ingredientes."],
      flow: "TOMAR PEDIDOS:\n1. Pregunta qué quiere.",
      escalation: "Una alergia siempre se escala.",
      context: "- Último pedido: ninguno",
    });
    const p = buildSystemPrompt(input(["restaurante"]));
    for (const has of ["- Tomar pedidos de Negocio X.", "5. Un pedido solo existe", "6. Nunca inventes ingredientes.", "TOMAR PEDIDOS:\n1. Pregunta qué quiere.", "Una alergia siempre se escala.", "- Último pedido: ninguno"]) expect(p).toContain(has);
    expect(p).not.toContain("AGENDAR CITAS");
    // Con los dos modulos: citas primero (su regla es la 5) y despues restaurante.
    const both = buildSystemPrompt(input(["citas", "restaurante"]));
    expect(both).toContain("5. Una cita solo existe");
    expect(both).toContain("6. Un pedido solo existe");
    expect(both).toContain("TOMAR PEDIDOS:");
    expect(both.indexOf("AGENDAR CITAS")).toBeLessThan(both.indexOf("TOMAR PEDIDOS"));
  });

  it("lo que escribe un cliente o un negocio dentro de las secciones no se reinterpreta como variable", () => {
    registerModulePrompt("restaurante", { tasks: ["- Atender a {{nombre_negocio}}."] });
    const i = input(["restaurante"]);
    (i.tenant as { name: string }).name = "Tacos {{fecha_hoy}}";
    expect(buildSystemPrompt(i)).toContain("- Atender a Tacos {{fecha_hoy}}.");
  });
});
