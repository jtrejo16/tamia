/**
 * Modulos de un negocio: lo que Jovia le enciende segun su giro.
 *
 * - "citas": servicios, especialistas, agenda y recordatorios. Lo tienen TODOS los giros actuales.
 * - "restaurante": menu, pedidos y (despues) reservaciones por aforo.
 *
 * El nucleo (conversaciones, clientes, canales, voz, avisos al equipo, estadisticas, base de conocimiento) no es un
 * modulo: siempre esta. Un modulo aporta herramientas del agente, secciones del prompt y pantallas del panel.
 *
 * Vive aqui, sin codigo de servidor, para que lo usen el agente, la voz y el panel.
 */
export const MODULE_IDS = ["citas", "restaurante"] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/** Lo que tiene un negocio cuando su giro no dice otra cosa. Asi los negocios que ya existen no cambian. */
export const DEFAULT_MODULES: readonly ModuleId[] = ["citas"];

/** Modulos por giro (id del giro → modulos). Un giro que no aparece aqui usa DEFAULT_MODULES. */
export const VERTICAL_MODULES: Readonly<Record<string, readonly ModuleId[]>> = {};

const VALID = new Set<string>(MODULE_IDS);
export const isModuleId = (v: unknown): v is ModuleId => typeof v === "string" && VALID.has(v);

/**
 * Modulos activos de un negocio. `override` es `profile.modules`: si es una lista, manda sobre el giro (sirve para
 * encender un modulo a un negocio concreto o para probar uno nuevo con un solo cliente). Los nombres desconocidos se ignoran.
 */
export function modulesFor(vertical: string | null | undefined, override?: unknown): ModuleId[] {
  const base = Array.isArray(override) ? override : ((vertical ? VERTICAL_MODULES[vertical] : undefined) ?? DEFAULT_MODULES);
  return [...new Set(base.filter(isModuleId))];
}

export const hasModule = (modules: readonly string[], id: ModuleId): boolean => modules.includes(id);
