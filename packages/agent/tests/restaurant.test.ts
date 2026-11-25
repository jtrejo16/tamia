import { menuCategories, menuItemGroups, menuItems, menuModifierGroups, menuModifierOptions, tenants, type MenuCategoryRow, type MenuData, type MenuGroupRow } from "@empleado/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consultMenu, loadTurnContext, runTool, toolDefinitions } from "../src";
import { NOW, dropWorld, makeWorld, openDbs, type Handles, type World } from "./helpers";

// ---------------------------------------------------------------- la consulta, sin base de datos

const group = (over: Partial<MenuGroupRow> & { id: string; name: string }): MenuGroupRow => ({ required: false, multiple: false, maxChoices: null, options: [], ...over });
const item = (id: string, categoryId: string, name: string, priceCents: number, over: Partial<MenuCategoryRow["items"][number]> = {}) => ({
  id,
  categoryId,
  name,
  description: null,
  priceCents,
  available: true,
  groupIds: [] as string[],
  ...over,
});

const size = group({ id: "g1", name: "Tamaño", required: true, options: [{ id: "o1", name: "Chica", priceDeltaCents: 0, available: true }, { id: "o2", name: "Grande", priceDeltaCents: 6000, available: true }] });
const extras = group({ id: "g2", name: "Extras", multiple: true, maxChoices: 3, options: [{ id: "o3", name: "Queso", priceDeltaCents: 1500, available: true }, { id: "o4", name: "Piña", priceDeltaCents: 1200, available: false }] });

const MENU: MenuData = {
  groups: [size, extras],
  categories: [
    { id: "c1", name: "Pizzas", items: [item("i1", "c1", "Hawaiana", 12950, { description: "Jamón y piña", groupIds: ["g1", "g2"] }), item("i2", "c1", "Pepperoni", 13900, { groupIds: ["g1"] }), item("i3", "c1", "Mexicana", 14900, { available: false })] },
    { id: "c2", name: "Bebidas", items: [item("i4", "c2", "Refresco de piña", 2500), item("i5", "c2", "Agua", 1500)] },
  ],
};

describe("consultar el menu", () => {
  it("sin busqueda da un resumen por categorias con precios y marca lo agotado", async () => {
    const r = (await consultMenu(MENU, undefined)) as { categorias: Array<{ nombre: string; platillos: Array<Record<string, unknown>> }> };
    expect(r.categorias.map((c) => c.nombre)).toEqual(["Pizzas", "Bebidas"]);
    expect(r.categorias[0]!.platillos).toEqual([{ nombre: "Hawaiana", precio: "$129.50 MXN" }, { nombre: "Pepperoni", precio: "$139 MXN" }, { nombre: "Mexicana", precio: "$149 MXN", agotado: true }]);
    expect(await consultMenu(MENU, "   ")).toEqual(r);
  });

  it("busca por nombre sin importar mayusculas ni acentos, con precio y modificadores (obligatorios, extras, agotados)", async () => {
    for (const q of ["hawaiana", "HAWAIANA", "háwaiana", "pizza hawaiana"]) {
      const r = (await consultMenu(MENU, q)) as { resultados: Array<Record<string, any>> };
      expect(r.resultados, q).toHaveLength(1);
      expect(r.resultados[0]).toMatchObject({ nombre: "Hawaiana", categoria: "Pizzas", descripcion: "Jamón y piña", precio: "$129.50 MXN" });
    }
    const hawaiana = ((await consultMenu(MENU, "hawaiana")) as { resultados: Array<Record<string, any>> }).resultados[0]!;
    expect(hawaiana.modificadores).toEqual([
      { nombre: "Tamaño", obligatorio: true, una_sola_opcion: true, opciones: [{ nombre: "Chica" }, { nombre: "Grande", extra: "+$60 MXN" }] },
      { nombre: "Extras", obligatorio: false, varias_opciones: true, maximo: 3, opciones: [{ nombre: "Queso", extra: "+$15 MXN" }, { nombre: "Piña", extra: "+$12 MXN", agotada: true }] },
    ]);
  });

  it("encuentra por ingrediente (descripcion); lo que coincide en el nombre va primero; un agotado se marca", async () => {
    const r = (await consultMenu(MENU, "piña")) as { resultados: Array<Record<string, unknown>> };
    expect(r.resultados.map((x) => x.nombre)).toEqual(["Refresco de piña", "Hawaiana"]); // nombre antes que descripcion
    const mexicana = ((await consultMenu(MENU, "mexicana")) as { resultados: Array<Record<string, unknown>> }).resultados[0]!;
    expect(mexicana).toMatchObject({ nombre: "Mexicana", agotado: true });
  });

  it("una categoria devuelve todos sus platillos con detalle", async () => {
    const r = (await consultMenu(MENU, "bebidas")) as { categoria: string; platillos: Array<Record<string, unknown>> };
    expect(r.categoria).toBe("Bebidas");
    expect(r.platillos.map((p) => p.nombre)).toEqual(["Refresco de piña", "Agua"]);
    expect(await consultMenu(MENU, "BEBIDAS")).toMatchObject({ categoria: "Bebidas" });
  });

  it("lo que no existe dice que no existe y no inventa alternativas", async () => {
    const r = await consultMenu(MENU, "sushi");
    expect(r).toMatchObject({ sin_resultados: true, categorias_disponibles: ["Pizzas", "Bebidas"] });
    expect(JSON.stringify(r)).toContain("No lo ofrezcas");
    expect(await consultMenu(MENU, "pizza sushi")).toMatchObject({ sin_resultados: true }); // todas las palabras deben coincidir
  });

  it("un menu vacio lo dice con honestidad y manda a una persona; uno grande solo lista categorias; muchos resultados se recortan", async () => {
    expect(await consultMenu({ categories: [], groups: [] }, "taco")).toMatchObject({ error: "menu_vacio" });
    expect(await consultMenu({ categories: [{ id: "c", name: "Vacia", items: [] }], groups: [] }, undefined)).toMatchObject({ error: "menu_vacio" });

    const many = (n: number): MenuData => ({ groups: [], categories: [{ id: "c", name: "Tacos", items: Array.from({ length: n }, (_, i) => item(`i${i}`, "c", `Taco ${i}`, 1000)) }] });
    const big = (await consultMenu(many(61), undefined)) as { categorias: Array<Record<string, unknown>> };
    expect(big.categorias).toEqual([{ nombre: "Tacos", cantidad_de_platillos: 61 }]);
    const exact = (await consultMenu(many(60), undefined)) as { categorias: Array<{ platillos: unknown[] }> };
    expect(exact.categorias[0]!.platillos).toHaveLength(60);
    const hits = (await consultMenu(many(20), "taco")) as { resultados: unknown[]; hay_mas: number };
    expect(hits.resultados).toHaveLength(8);
    expect(hits.hay_mas).toBe(12);
  });
});

// ------------------------------------------------------- la herramienta, con base de datos y modulos

let dbs: Handles;
const worlds: World[] = [];
beforeAll(() => {
  dbs = openDbs();
});
afterAll(async () => {
  for (const w of worlds) await dropWorld(dbs.owner, w);
  await dbs.app.close();
  await dbs.owner.close();
});

async function seededRestaurant(withModule: boolean) {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  if (withModule) await dbs.owner.db.update(tenants).set({ profile: { cancellationNoticeHours: 12, modules: ["restaurante"] } }).where(eq(tenants.id, w.tenantId));
  const db = dbs.owner.db;
  const [cat] = await db.insert(menuCategories).values({ tenantId: w.tenantId, name: "Tacos" }).returning();
  const [it] = await db.insert(menuItems).values({ tenantId: w.tenantId, categoryId: cat!.id, name: "Pastor", description: "Con piña y cebolla", priceCents: 1800 }).returning();
  const [g] = await db.insert(menuModifierGroups).values({ tenantId: w.tenantId, name: "Tortilla", required: true }).returning();
  await db.insert(menuModifierOptions).values([{ tenantId: w.tenantId, groupId: g!.id, name: "Maíz", sortOrder: 0 }, { tenantId: w.tenantId, groupId: g!.id, name: "Harina", priceDeltaCents: 300, sortOrder: 1 }]);
  await db.insert(menuItemGroups).values({ tenantId: w.tenantId, itemId: it!.id, groupId: g!.id });
  return w;
}

describe("la herramienta consultar_menu en un negocio", () => {
  it("un restaurante la ve, la usa y recibe SU menu real", async () => {
    const w = await seededRestaurant(true);
    const ctx = await loadTurnContext(dbs.app.db, w.tenantId, w.conversationId, { now: NOW });
    expect(toolDefinitions(["restaurante"]).map((t) => t.function.name)).toContain("consultar_menu");
    const run = await runTool("consultar_menu", JSON.stringify({ busqueda: "pastor" }), ctx);
    expect(run.result).toMatchObject({
      resultados: [
        {
          nombre: "Pastor",
          categoria: "Tacos",
          precio: "$18 MXN",
          modificadores: [{ nombre: "Tortilla", obligatorio: true, opciones: [{ nombre: "Maíz" }, { nombre: "Harina", extra: "+$3 MXN" }] }],
        },
      ],
    });
    // Sin busqueda: resumen.
    expect((await runTool("consultar_menu", "{}", ctx)).result).toMatchObject({ categorias: [{ nombre: "Tacos", platillos: [{ nombre: "Pastor", precio: "$18 MXN" }] }] });
  });

  it("un negocio sin el modulo no la tiene: para el agente no existe", async () => {
    const w = await seededRestaurant(false);
    const ctx = await loadTurnContext(dbs.app.db, w.tenantId, w.conversationId, { now: NOW });
    const run = await runTool("consultar_menu", "{}", ctx);
    expect(run.result).toMatchObject({ error: "herramienta_desconocida" });
    expect(JSON.stringify(run.result)).not.toContain("consultar_menu\"]"); // ni aparece en la lista de disponibles
  });

  it("nunca trae el menu de otro negocio", async () => {
    const a = await seededRestaurant(true);
    const b = await makeWorld(dbs.owner);
    worlds.push(b);
    await dbs.owner.db.update(tenants).set({ profile: { cancellationNoticeHours: 12, modules: ["restaurante"] } }).where(eq(tenants.id, b.tenantId));
    const ctxB = await loadTurnContext(dbs.app.db, b.tenantId, b.conversationId, { now: NOW });
    expect((await runTool("consultar_menu", JSON.stringify({ busqueda: "pastor" }), ctxB)).result).toMatchObject({ error: "menu_vacio" });
    expect(a.tenantId).not.toBe(b.tenantId);
  });
});
