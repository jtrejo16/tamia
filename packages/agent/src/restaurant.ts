import { loadMenu, withTenant, type MenuCategoryRow, type MenuData, type MenuGroupRow, type MenuItemRow } from "@empleado/db";
import { z } from "zod";
import { formatMoney } from "./format";
import { defineModuleTool, registerModulePrompt, registerModuleTools } from "./modules";
import type { ToolResult } from "./types";

/**
 * Modulo "restaurante" del agente. Etapa 1: el agente CONSULTA el menu (platillos, precios, modificadores). Tomar pedidos y
 * reservar llegan despues. El menu vive en la base de datos: nunca va dentro del prompt.
 * Este archivo se carga una sola vez, desde index.ts, y registra el modulo.
 */

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const words = (s: string) => norm(s).split(/[^a-z0-9ñ]+/).filter((w) => w.length > 0);

/** Platillos que se listan sin busqueda; con mas, solo las categorias (para no soltar una lista enorme). */
const OVERVIEW_LIMIT = 60;
const MAX_RESULTS = 8;

const money = (cents: number) => formatMoney(cents);

function describeGroup(g: MenuGroupRow) {
  return {
    nombre: g.name,
    obligatorio: g.required,
    ...(g.multiple ? { varias_opciones: true, ...(g.maxChoices ? { maximo: g.maxChoices } : {}) } : { una_sola_opcion: true }),
    opciones: g.options.map((o) => ({
      nombre: o.name,
      ...(o.priceDeltaCents > 0 ? { extra: `+${money(o.priceDeltaCents)}` } : {}),
      ...(o.available ? {} : { agotada: true }),
    })),
  };
}

function describeItem(item: MenuItemRow, category: MenuCategoryRow, groups: Map<string, MenuGroupRow>) {
  return {
    nombre: item.name,
    categoria: category.name,
    ...(item.description ? { descripcion: item.description } : {}),
    precio: money(item.priceCents),
    ...(item.available ? {} : { agotado: true }),
    ...(item.groupIds.length > 0 ? { modificadores: item.groupIds.flatMap((id) => (groups.has(id) ? [describeGroup(groups.get(id)!)] : [])) } : {}),
  };
}

/** Sin busqueda: lo que hay, por categoria. */
function overview(menu: MenuData): ToolResult {
  const total = menu.categories.reduce((n, c) => n + c.items.length, 0);
  if (total <= OVERVIEW_LIMIT) {
    return {
      categorias: menu.categories.map((c) => ({
        nombre: c.name,
        platillos: c.items.map((i) => ({ nombre: i.name, precio: money(i.priceCents), ...(i.available ? {} : { agotado: true }) })),
      })),
      instruccion: "Resume por categorías y ofrece dar el detalle (ingredientes, modificadores) de lo que le interese con consultar_menu.",
    };
  }
  return {
    categorias: menu.categories.map((c) => ({ nombre: c.name, cantidad_de_platillos: c.items.length })),
    instruccion: "El menú es grande: menciona las categorías y pregunta cuál le interesa; luego busca esa categoría con consultar_menu.",
  };
}

export async function consultMenu(menu: MenuData, query: string | undefined): Promise<ToolResult> {
  if (menu.categories.every((c) => c.items.length === 0)) {
    return { error: "menu_vacio", instruccion: "El menú todavía no está cargado. Díselo al cliente con honestidad y usa escalar_a_humano." };
  }
  const q = words(query ?? "");
  if (q.length === 0) return overview(menu);

  const groups = new Map(menu.groups.map((g) => [g.id, g]));
  const category = menu.categories.find((c) => norm(c.name) === norm(query ?? "") || words(c.name).join(" ") === q.join(" "));
  if (category) {
    return {
      categoria: category.name,
      platillos: category.items.map((i) => describeItem(i, category, groups)),
      instruccion: "Presenta los platillos con su precio; da el detalle de los modificadores solo si preguntan.",
    };
  }

  // Cada palabra debe aparecer en el nombre, la descripcion o la categoria. Lo que coincide en el NOMBRE va primero.
  const hits: Array<{ score: number; item: MenuItemRow; category: MenuCategoryRow }> = [];
  for (const c of menu.categories) {
    for (const i of c.items) {
      const inName = words(i.name).join(" ");
      const hay = `${inName} ${words(i.description ?? "").join(" ")} ${words(c.name).join(" ")}`;
      if (!q.every((w) => hay.includes(w))) continue;
      hits.push({ score: q.every((w) => inName.includes(w)) ? 0 : 1, item: i, category: c });
    }
  }
  hits.sort((a, b) => a.score - b.score);
  if (hits.length === 0) {
    return {
      sin_resultados: true,
      categorias_disponibles: menu.categories.map((c) => c.name),
      instruccion: "Ese platillo no está en el menú. No lo ofrezcas ni inventes alternativas: di que no lo manejan y ofrece lo que sí hay en las categorías disponibles.",
    };
  }
  return {
    resultados: hits.slice(0, MAX_RESULTS).map((h) => describeItem(h.item, h.category, groups)),
    ...(hits.length > MAX_RESULTS ? { hay_mas: hits.length - MAX_RESULTS } : {}),
    instruccion: "Usa SOLO estos datos. Un platillo marcado como agotado no se ofrece. Menciona los modificadores obligatorios y sus costos extra.",
  };
}

registerModuleTools("restaurante", [
  defineModuleTool({
    name: "consultar_menu",
    description:
      "Consulta el menú real del restaurante: platillos, precios, ingredientes y modificadores (tamaños, extras, etc.). Úsala para CUALQUIER pregunta de platillos o precios. Sin 'busqueda' devuelve un resumen por categorías; con una palabra (un platillo, un ingrediente o una categoría) devuelve el detalle.",
    mutating: false,
    schema: z.object({
      busqueda: z.string().trim().max(120).optional().describe("Platillo, ingrediente o categoría, por ejemplo 'pastor', 'hawaiana', 'bebidas'. Vacío = resumen del menú."),
    }),
    async execute(args, ctx) {
      const menu = await withTenant(ctx.db, { tenantId: ctx.tenantId }, (tx) => loadMenu(tx));
      return consultMenu(menu, args.busqueda);
    },
  }),
]);

registerModulePrompt("restaurante", {
  tasks: ["- Responder dudas del menú (platillos, precios, ingredientes y modificadores) usando consultar_menu."],
  truthRules: [
    "Platillos, precios, ingredientes y modificadores salen SOLO de consultar_menu. Si un platillo no aparece, no existe: no lo ofrezcas ni inventes alternativas. Si está agotado, dilo y ofrece otra cosa del menú.",
    "Nunca inventes ingredientes ni alérgenos. Si preguntan por alergias, intolerancias o dietas y el menú no lo dice, escala a una persona antes de recomendar algo.",
  ],
  flow: `CONSULTAR EL MENÚ:
1. Para cualquier precio o platillo usa consultar_menu con lo que pide el cliente (una palabra basta). No respondas de memoria.
2. Si piden "el menú" o una categoría, resume las categorías y ofrece dar el detalle; no pegues listas enormes.
3. Di los precios en pesos y menciona los modificadores obligatorios (por ejemplo el tamaño) con su costo extra.
4. Por ahora no tomas pedidos ni reservaciones: si el cliente quiere pedir o reservar, avísale que lo pasas con una persona del equipo y usa escalar_a_humano.`,
});
