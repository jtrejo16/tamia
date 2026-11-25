import type { Tenant } from "@empleado/db";
import { modulesFor, type ModuleId } from "@empleado/shared/modules";
import type { z } from "zod";
import type { ToolResult, TurnContext } from "./types";

/**
 * Modulos del agente. Un modulo (citas, restaurante...) aporta:
 *  - herramientas del agente (registerModuleTools),
 *  - secciones del prompt (registerModulePrompt).
 * Lo que no es de ningun modulo (horario, conocimiento, datos del cliente, ubicacion, escalar a una persona) es del nucleo y
 * siempre esta. Que modulos tiene un negocio sale de su giro o de profile.modules (ver modulesFor en @empleado/shared).
 */

export const activeModules = (tenant: Pick<Tenant, "vertical" | "profile">): ModuleId[] =>
  modulesFor(tenant.vertical, tenant.profile?.modules);

// --------------------------------------------------------------------------------------- herramientas

/** Una herramienta que aporta un modulo (las del nucleo y las de citas viven en tools.ts). */
export interface ModuleTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  /** Modifica datos del negocio: pasa por la politica de aprobacion y por la confirmacion del cliente. */
  mutating: boolean;
  schema: S;
  execute: (args: z.output<S>, ctx: TurnContext) => Promise<ToolResult>;
}

/** Define una herramienta con sus argumentos ya tipados por su esquema (zod). */
export function defineModuleTool<S extends z.ZodType>(tool: ModuleTool<S>): ModuleTool {
  // Seguro: el registro solo ejecuta la herramienta con lo que valido su PROPIO esquema (ver runModuleTool).
  return tool as unknown as ModuleTool;
}

const moduleTools = new Map<ModuleId, ModuleTool[]>();

export function registerModuleTools(module: ModuleId, tools: ModuleTool[]): void {
  moduleTools.set(module, tools);
}

/** Herramientas de los modulos pedidos, en el orden de los modulos. */
export function toolsOfModules(modules: readonly string[]): Array<{ module: ModuleId; tool: ModuleTool }> {
  return [...moduleTools].filter(([m]) => modules.includes(m)).flatMap(([module, list]) => list.map((tool) => ({ module, tool })));
}

/** Busca una herramienta de modulo por nombre, aunque el negocio no tenga ese modulo (quien llama decide si esta disponible). */
export function findModuleTool(name: string): { module: ModuleId; tool: ModuleTool } | null {
  for (const [module, list] of moduleTools) {
    const tool = list.find((t) => t.name === name);
    if (tool) return { module, tool };
  }
  return null;
}

// -------------------------------------------------------------------------------------------- prompt

/**
 * Secciones del prompt de un modulo. Pueden llevar {{variables}} del prompt maestro. Cada seccion va entera (sin salto de
 * linea final: el armado lo agrega).
 */
export interface ModulePrompt {
  /** Renglones de "TU TRABAJO", cada uno ya con su guion: "- Agendar...". */
  tasks?: string[];
  /** Reglas de verdad adicionales, SIN numero (se numeran a continuacion de las del nucleo). */
  truthRules?: string[];
  /** Flujo de trabajo del modulo (por ejemplo "AGENDAR CITAS: ..."). */
  flow?: string;
  /** Reglas del modulo sobre cuando escalar y como hablar de lo suyo. */
  escalation?: string;
  /** Renglon(es) del contexto del cliente ("- Citas próximas: ..."). */
  context?: string;
}

const modulePrompts = new Map<ModuleId, ModulePrompt>();

export function registerModulePrompt(module: ModuleId, sections: ModulePrompt): void {
  modulePrompts.set(module, sections);
}

/** Secciones de los modulos pedidos, en el orden de los modulos. */
export function promptsOfModules(modules: readonly string[]): ModulePrompt[] {
  return [...modulePrompts].filter(([m]) => modules.includes(m)).map(([, p]) => p);
}

// El modulo de citas: lo que antes estaba escrito directo en el prompt maestro (el texto no cambia).
registerModulePrompt("citas", {
  tasks: ["- Agendar, cambiar y cancelar citas usando las herramientas."],
  truthRules: [`Una cita solo existe si una herramienta lo confirmó. Nunca digas "quedó agendada" sin el resultado de la herramienta.`],
  flow: `AGENDAR CITAS:
1. Identifica el servicio. Si no es claro, ofrece las opciones con consultar_servicios.
2. Pregunta preferencia de día/horario y, si aplica, de {{nombre_rol_empleado}}.
3. Usa buscar_disponibilidad y ofrece máximo 3 opciones concretas.
4. Pide solo los datos que faltan: {{datos_requeridos_cita}}. No pidas nada que ya aparezca en el perfil del cliente (incluido su teléfono). Guárdalos con guardar_datos_contacto. Si ya tienes todo, no hagas más preguntas: busca disponibilidad o prepara el resumen.
5. ANTES de crear, cambiar o cancelar: llama la herramienta SIN confirmado para obtener el resumen (servicio, con quién, día, hora, precio, anticipo si aplica), repítelo al cliente y pide confirmación explícita. Solo cuando el cliente responda que sí, vuelve a llamarla con confirmado=true.
6. Confirma al cliente usando el resultado real de la herramienta, nunca antes.
7. Cancelaciones y cambios: aplica la política de cancelación del negocio: {{politica_cancelacion}}.`,
  escalation: `CITAS DEL CLIENTE: solo habla de las citas que aparecen en "Citas próximas". Si dice "ninguna", el cliente NO tiene citas: dilo y ofrece agendar. Nunca tomes una fecha, hora o cita de mensajes anteriores de la conversación (recordatorios o respuestas viejas): pueden ser de otro día o estar canceladas. Ante la duda, consulta con buscar_citas_del_contacto.
Pedir una cita NO es motivo para escalar: agéndala con las herramientas. Solo escala si de verdad no puedes (por ejemplo, no hay servicios o disponibilidad cargados), y dilo en el motivo.`,
  context: "- Citas próximas: {{citas_contacto}}",
});
