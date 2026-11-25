import { auditLog, loadMenu, menuItems, tenants, withTenant } from "@empleado/db";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deleteCategory,
  deleteGroup,
  deleteItem,
  exportMenuCsv,
  getMenu,
  importMenuCsv,
  saveCategory,
  saveGroup,
  saveItem,
  setItemAvailable,
  setOptionAvailable,
} from "../src";
import { dropWorld, makeWorld, openDbs, type Dbs, type World } from "./helpers";

let dbs: Dbs;
const worlds: World[] = [];
beforeAll(() => {
  dbs = openDbs();
});
afterAll(async () => {
  for (const w of worlds) await dropWorld(dbs.owner, w);
  await dbs.app.close();
  await dbs.owner.close();
});

/** Un negocio con el modulo de restaurante encendido (por profile.modules). */
async function restaurant(withModule = true) {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  if (withModule) await dbs.owner.db.update(tenants).set({ profile: { cancellationNoticeHours: 12, modules: ["restaurante"] } }).where(eq(tenants.id, w.tenantId));
  return w;
}
const tree = (w: World) => withTenant(dbs.app.db, { tenantId: w.tenantId }, (tx) => loadMenu(tx));
const ok = <T>(r: T): Extract<T, { ok: true }> => {
  expect(r).toMatchObject({ ok: true });
  return r as Extract<T, { ok: true }>;
};

describe("permisos y modulo", () => {
  it("un negocio sin el modulo de restaurante no tiene menu: ni leer ni escribir", async () => {
    const w = await restaurant(false);
    expect(await getMenu(dbs.app.db, w.owner)).toEqual({ ok: false, error: "module_off" });
    expect(await saveCategory(dbs.app.db, w.owner, { name: "Tacos" })).toEqual({ ok: false, error: "module_off" });
    expect(await exportMenuCsv(dbs.app.db, w.owner)).toEqual({ ok: false, error: "module_off" });
    expect(await importMenuCsv(dbs.app.db, w.owner, "categoria,nombre,precio\nA,B,1")).toEqual({ ok: false, error: "module_off" });
  });

  it("el lector ve el menu pero no lo cambia; la recepcion y el dueño si", async () => {
    const w = await restaurant();
    ok(await saveCategory(dbs.app.db, w.agent, { name: "Tacos" }));
    expect(ok(await getMenu(dbs.app.db, w.viewer)).menu.categories.map((c) => c.name)).toEqual(["Tacos"]);
    expect(await saveCategory(dbs.app.db, w.viewer, { name: "Bebidas" })).toEqual({ ok: false, error: "forbidden" });
    expect(await importMenuCsv(dbs.app.db, w.viewer, "categoria,nombre,precio\nA,B,1")).toEqual({ ok: false, error: "forbidden" });
    ok(await saveCategory(dbs.app.db, w.owner, { name: "Bebidas" }));
  });
});

describe("categorias y platillos", () => {
  it("crea, renombra, ordena por alta, no repite nombres (sin importar mayusculas) y borra la categoria con sus platillos", async () => {
    const w = await restaurant();
    const tacos = ok(await saveCategory(dbs.app.db, w.agent, { name: " Tacos " })).id;
    const bebidas = ok(await saveCategory(dbs.app.db, w.agent, { name: "Bebidas" })).id;
    expect((await tree(w)).categories.map((c) => c.name)).toEqual(["Tacos", "Bebidas"]);
    expect(await saveCategory(dbs.app.db, w.agent, { name: "TACOS" })).toEqual({ ok: false, error: "duplicate" });
    expect(await saveCategory(dbs.app.db, w.agent, { name: "" })).toMatchObject({ ok: false, error: "invalid" });
    ok(await saveCategory(dbs.app.db, w.agent, { id: bebidas, name: "Refrescos" }));
    expect(await saveCategory(dbs.app.db, w.agent, { id: "00000000-0000-4000-8000-000000000000", name: "X" })).toEqual({ ok: false, error: "not_found" });

    ok(await saveItem(dbs.app.db, w.agent, { categoryId: tacos, name: "Pastor", price: 18 }));
    expect(ok(await deleteCategory(dbs.app.db, w.agent, tacos))).toBeTruthy();
    expect(await dbs.owner.db.select().from(menuItems).where(eq(menuItems.tenantId, w.tenantId))).toHaveLength(0);
    expect(await deleteCategory(dbs.app.db, w.agent, tacos)).toEqual({ ok: false, error: "not_found" });
  });

  it("guarda el precio en centavos desde pesos en varios formatos, y valida todo", async () => {
    const w = await restaurant();
    const cat = ok(await saveCategory(dbs.app.db, w.agent, { name: "Pizzas" })).id;
    const a = ok(await saveItem(dbs.app.db, w.agent, { categoryId: cat, name: "Hawaiana", description: " Piña y jamón ", price: "$129.50" })).id;
    ok(await saveItem(dbs.app.db, w.agent, { categoryId: cat, name: "Pepperoni", price: 139 }));
    const items = (await tree(w)).categories[0]!.items;
    expect(items.map((i) => [i.name, i.priceCents, i.available])).toEqual([["Hawaiana", 12950, true], ["Pepperoni", 13900, true]]);
    expect(items[0]!.description).toBe("Piña y jamón");

    const bad = async (patch: object) => saveItem(dbs.app.db, w.agent, { categoryId: cat, name: "Prueba", price: 10, ...patch });
    for (const patch of [{ name: "" }, { name: "x".repeat(121) }, { price: -5 }, { price: "gratis" }, { price: 100001 }, { description: "d".repeat(501) }, { categoryId: undefined }, { groupIds: Array.from({ length: 11 }, (_, i) => `g${i}`) }]) {
      expect(await bad(patch)).toMatchObject({ ok: false, error: "invalid" });
    }
    expect(await bad({ categoryId: "00000000-0000-4000-8000-000000000000" })).toMatchObject({ ok: false, error: "invalid" });
    expect(await bad({ groupIds: ["00000000-0000-4000-8000-000000000000"] })).toMatchObject({ ok: false, error: "invalid" });

    // El mismo nombre en la misma categoria no se repite (aunque cambien mayusculas); en otra categoria si.
    expect(await saveItem(dbs.app.db, w.agent, { categoryId: cat, name: "hawaiana", price: 1 })).toEqual({ ok: false, error: "duplicate" });
    const otra = ok(await saveCategory(dbs.app.db, w.agent, { name: "Combos" })).id;
    ok(await saveItem(dbs.app.db, w.agent, { categoryId: otra, name: "Hawaiana", price: 1 }));

    // Editar, apagar (agotado), prender y borrar.
    ok(await saveItem(dbs.app.db, w.agent, { id: a, categoryId: cat, name: "Hawaiana", price: 135, available: false }));
    expect((await tree(w)).categories[0]!.items[0]).toMatchObject({ priceCents: 13500, available: false });
    ok(await setItemAvailable(dbs.app.db, w.agent, a, true));
    expect((await tree(w)).categories[0]!.items[0]!.available).toBe(true);
    ok(await deleteItem(dbs.app.db, w.agent, a));
    expect(await deleteItem(dbs.app.db, w.agent, a)).toEqual({ ok: false, error: "not_found" });
    expect(await setItemAvailable(dbs.app.db, w.agent, a, false)).toEqual({ ok: false, error: "not_found" });
  });
});

describe("modificadores", () => {
  const pizzaGroup = (over: object = {}) => ({
    name: "Tamaño",
    required: true,
    options: [{ name: "Chica", price: 0 }, { name: "Mediana", price: 30 }, { name: "Grande", price: 60 }],
    ...over,
  });

  it("un grupo se define una vez y se pega a varios platillos, en orden; el precio extra se cambia en un solo lugar", async () => {
    const w = await restaurant();
    const cat = ok(await saveCategory(dbs.app.db, w.agent, { name: "Pizzas" })).id;
    const size = ok(await saveGroup(dbs.app.db, w.agent, pizzaGroup())).id;
    const extras = ok(await saveGroup(dbs.app.db, w.agent, { name: "Extras", multiple: true, maxChoices: 3, options: [{ name: "Queso extra", price: "$15" }, { name: "Champiñones", price: 12 }] })).id;
    const p1 = ok(await saveItem(dbs.app.db, w.agent, { categoryId: cat, name: "Hawaiana", price: 99, groupIds: [size, extras] })).id;
    const p2 = ok(await saveItem(dbs.app.db, w.agent, { categoryId: cat, name: "Pepperoni", price: 109, groupIds: [extras, size] })).id;

    let menu = await tree(w);
    expect(menu.groups.map((g) => g.name)).toEqual(["Extras", "Tamaño"]);
    const sizeRow = menu.groups.find((g) => g.id === size)!;
    expect(sizeRow).toMatchObject({ required: true, multiple: false, maxChoices: null });
    expect(sizeRow.options.map((o) => [o.name, o.priceDeltaCents])).toEqual([["Chica", 0], ["Mediana", 3000], ["Grande", 6000]]);
    expect(menu.groups.find((g) => g.id === extras)).toMatchObject({ multiple: true, maxChoices: 3 });
    const items = menu.categories[0]!.items;
    expect(items.find((i) => i.id === p1)!.groupIds).toEqual([size, extras]);
    expect(items.find((i) => i.id === p2)!.groupIds).toEqual([extras, size]); // cada platillo guarda su orden

    // Cambiar un precio extra, una vez, lo cambia en todos los platillos que lo usan.
    const grande = sizeRow.options.find((o) => o.name === "Grande")!;
    ok(await saveGroup(dbs.app.db, w.agent, { id: size, name: "Tamaño", required: true, options: sizeRow.options.map((o) => ({ id: o.id, name: o.name, price: o.id === grande.id ? 70 : o.priceDeltaCents / 100 })) }));
    menu = await tree(w);
    expect(menu.groups.find((g) => g.id === size)!.options.find((o) => o.id === grande.id)!.priceDeltaCents).toBe(7000);

    // Quitar un grupo de un platillo: se vuelve a guardar con otra lista.
    ok(await saveItem(dbs.app.db, w.agent, { id: p1, categoryId: cat, name: "Hawaiana", price: 99, groupIds: [size] }));
    expect((await tree(w)).categories[0]!.items.find((i) => i.id === p1)!.groupIds).toEqual([size]);
  });

  it("al guardar un grupo: las opciones nuevas se crean, las que faltan se borran, y se pueden intercambiar nombres", async () => {
    const w = await restaurant();
    const g = ok(await saveGroup(dbs.app.db, w.agent, { name: "Masa", options: [{ name: "Delgada" }, { name: "Gruesa" }, { name: "Rellena" }] })).id;
    const [delgada, gruesa, rellena] = (await tree(w)).groups[0]!.options;
    ok(await saveGroup(dbs.app.db, w.agent, { id: g, name: "Masa", options: [{ id: gruesa!.id, name: "Delgada" }, { id: delgada!.id, name: "Gruesa" }, { name: "Orilla de queso", price: 25 }] }));
    const after = (await tree(w)).groups[0]!.options;
    expect(after.map((o) => o.name)).toEqual(["Delgada", "Gruesa", "Orilla de queso"]);
    expect(after[0]!.id).toBe(gruesa!.id); // se intercambiaron los nombres sin chocar
    expect(after.some((o) => o.id === rellena!.id)).toBe(false);

    ok(await setOptionAvailable(dbs.app.db, w.agent, after[2]!.id, false));
    expect((await tree(w)).groups[0]!.options[2]!.available).toBe(false);
    expect(await setOptionAvailable(dbs.app.db, w.agent, "00000000-0000-4000-8000-000000000000", true)).toEqual({ ok: false, error: "not_found" });
    // Una opcion que ya no existe (otra persona la borro): se pide recargar.
    expect(await saveGroup(dbs.app.db, w.agent, { id: g, name: "Masa", options: [{ id: rellena!.id, name: "Rellena" }] })).toMatchObject({ ok: false, error: "invalid" });
  });

  it("valida el grupo y no repite nombres; borrarlo lo quita de los platillos pero no los borra", async () => {
    const w = await restaurant();
    const bad = (patch: object) => saveGroup(dbs.app.db, w.agent, pizzaGroup(patch));
    for (const patch of [{ name: "" }, { options: [] }, { options: undefined }, { options: [{ name: "" }] }, { options: [{ name: "A" }, { name: "a" }] }, { options: [{ name: "A", price: -1 }] }, { multiple: true, maxChoices: 0 }, { multiple: true, maxChoices: 21 }, { options: Array.from({ length: 41 }, (_, i) => ({ name: `o${i}` })) }]) {
      expect(await bad(patch)).toMatchObject({ ok: false, error: "invalid" });
    }
    const g = ok(await saveGroup(dbs.app.db, w.agent, pizzaGroup())).id;
    expect(await saveGroup(dbs.app.db, w.agent, pizzaGroup({ name: "TAMAÑO" }))).toEqual({ ok: false, error: "duplicate" });
    // maxChoices solo cuenta si se pueden elegir varias.
    const single = ok(await saveGroup(dbs.app.db, w.agent, { name: "Tortilla", maxChoices: 5, options: [{ name: "Maíz" }, { name: "Harina" }] })).id;
    expect((await tree(w)).groups.find((x) => x.id === single)!.maxChoices).toBeNull();

    const cat = ok(await saveCategory(dbs.app.db, w.agent, { name: "Pizzas" })).id;
    ok(await saveItem(dbs.app.db, w.agent, { categoryId: cat, name: "Hawaiana", price: 99, groupIds: [g] }));
    ok(await deleteGroup(dbs.app.db, w.agent, g));
    const menu = await tree(w);
    expect(menu.categories[0]!.items[0]!.groupIds).toEqual([]);
    expect(menu.groups.map((x) => x.name)).toEqual(["Tortilla"]);
    expect(await deleteGroup(dbs.app.db, w.agent, g)).toEqual({ ok: false, error: "not_found" });
  });
});

describe("aislamiento entre negocios", () => {
  it("un negocio no ve, cambia ni enlaza lo de otro, aunque conozca los id", async () => {
    const a = await restaurant();
    const b = await restaurant();
    const catA = ok(await saveCategory(dbs.app.db, a.agent, { name: "Tacos" })).id;
    const itemA = ok(await saveItem(dbs.app.db, a.agent, { categoryId: catA, name: "Pastor", price: 18 })).id;
    const groupA = ok(await saveGroup(dbs.app.db, a.agent, { name: "Salsa", options: [{ name: "Verde" }] })).id;

    expect((await tree(b)).categories).toEqual([]);
    expect((await tree(b)).groups).toEqual([]);
    // Con los id de A, B no puede nada.
    expect(await saveItem(dbs.app.db, b.agent, { categoryId: catA, name: "Intruso", price: 1 })).toMatchObject({ ok: false, error: "invalid" });
    expect(await saveItem(dbs.app.db, b.agent, { id: itemA, categoryId: catA, name: "Robado", price: 1 })).toMatchObject({ ok: false });
    const catB = ok(await saveCategory(dbs.app.db, b.agent, { name: "Tacos" })).id; // el mismo nombre en otro negocio esta bien
    expect(await saveItem(dbs.app.db, b.agent, { categoryId: catB, name: "Mio", price: 1, groupIds: [groupA] })).toMatchObject({ ok: false, error: "invalid" });
    expect(await deleteItem(dbs.app.db, b.agent, itemA)).toEqual({ ok: false, error: "not_found" });
    expect(await deleteCategory(dbs.app.db, b.agent, catA)).toEqual({ ok: false, error: "not_found" });
    expect(await deleteGroup(dbs.app.db, b.agent, groupA)).toEqual({ ok: false, error: "not_found" });
    expect(await setItemAvailable(dbs.app.db, b.agent, itemA, false)).toEqual({ ok: false, error: "not_found" });
    expect(await saveCategory(dbs.app.db, b.agent, { id: catA, name: "Cambiado" })).toEqual({ ok: false, error: "not_found" });
    // Lo de A sigue intacto.
    expect((await tree(a)).categories[0]).toMatchObject({ name: "Tacos", items: [{ name: "Pastor", priceCents: 1800, available: true }] });
  });
});

const CSV = [
  "categoria,nombre,descripcion,precio,disponible,modificadores",
  'Pizzas,Hawaiana,"Piña, jamón y queso",$129.50,si,Tamaño | Extras',
  "Pizzas,Pepperoni,,139,sí,Tamaño",
  "Bebidas,Refresco,,25,no,",
  "Bebidas,Agua,,15,,",
].join("\n");

describe("importar y exportar el menu (CSV)", () => {
  async function withGroups() {
    const w = await restaurant();
    ok(await saveGroup(dbs.app.db, w.agent, { name: "Tamaño", required: true, options: [{ name: "Chica" }, { name: "Grande", price: 60 }] }));
    ok(await saveGroup(dbs.app.db, w.agent, { name: "Extras", multiple: true, options: [{ name: "Queso", price: 15 }] }));
    return w;
  }

  it("la prueba (dryRun) cuenta lo que haria y no escribe nada", async () => {
    const w = await withGroups();
    const r = ok(await importMenuCsv(dbs.app.db, w.agent, CSV, { dryRun: true }));
    expect(r.summary).toMatchObject({ dryRun: true, categoriesCreated: 2, itemsCreated: 4, itemsUpdated: 0, skipped: [], warnings: [] });
    expect((await tree(w)).categories).toEqual([]);
    expect(await dbs.owner.db.select().from(auditLog).where(and(eq(auditLog.tenantId, w.tenantId), like(auditLog.action, "menu.imported")))).toHaveLength(0);
  });

  it("importa categorias, platillos, precios, disponibilidad y enlaza modificadores por nombre", async () => {
    const w = await withGroups();
    const r = ok(await importMenuCsv(dbs.app.db, w.agent, CSV));
    expect(r.summary).toMatchObject({ dryRun: false, categoriesCreated: 2, itemsCreated: 4, itemsUpdated: 0, skipped: [], warnings: [] });
    const menu = await tree(w);
    expect(menu.categories.map((c) => c.name)).toEqual(["Pizzas", "Bebidas"]);
    const [hawaiana, pepperoni] = menu.categories[0]!.items;
    expect(hawaiana).toMatchObject({ name: "Hawaiana", description: "Piña, jamón y queso", priceCents: 12950, available: true });
    expect(hawaiana!.groupIds.map((id) => menu.groups.find((g) => g.id === id)!.name)).toEqual(["Tamaño", "Extras"]);
    expect(pepperoni!.groupIds).toHaveLength(1);
    expect(menu.categories[1]!.items.map((i) => [i.name, i.available])).toEqual([["Refresco", false], ["Agua", true]]); // vacio = disponible
    expect(await dbs.owner.db.select().from(auditLog).where(and(eq(auditLog.tenantId, w.tenantId), like(auditLog.action, "menu.imported")))).toHaveLength(1);
  });

  it("volver a importar el mismo archivo actualiza, no duplica; y un precio nuevo se aplica", async () => {
    const w = await withGroups();
    ok(await importMenuCsv(dbs.app.db, w.agent, CSV));
    const again = ok(await importMenuCsv(dbs.app.db, w.agent, CSV.replace("139", "149").replace("PIZZAS", "x")));
    expect(again.summary).toMatchObject({ categoriesCreated: 0, itemsCreated: 0, itemsUpdated: 4 });
    const menu = await tree(w);
    expect(menu.categories.flatMap((c) => c.items)).toHaveLength(4);
    expect(menu.categories[0]!.items.find((i) => i.name === "Pepperoni")!.priceCents).toBe(14900);
    // Diferencias de mayusculas en categoria o nombre apuntan al mismo platillo.
    const lower = ok(await importMenuCsv(dbs.app.db, w.agent, "categoria,nombre,precio\npizzas,HAWAIANA,100"));
    expect(lower.summary).toMatchObject({ itemsCreated: 0, itemsUpdated: 1 });
    // Sin la columna de modificadores, los enlaces no se tocan.
    expect((await tree(w)).categories[0]!.items[0]!.groupIds).toHaveLength(2);
  });

  it("salta los renglones malos con su motivo y avisa de los modificadores que no existen", async () => {
    const w = await withGroups();
    const csv = ["categoria,nombre,precio,modificadores", "Tacos,Pastor,18,Salsas", "Tacos,,10,", ",Sin categoria,10,", "Tacos,Gratis,gratis,", "Tacos,Pastor,99,", `Tacos,${"x".repeat(121)},5,`, "Tacos,Bistec,22,"].join("\n");
    const r = ok(await importMenuCsv(dbs.app.db, w.agent, csv));
    expect(r.summary.itemsCreated).toBe(2); // Pastor y Bistec
    expect(r.summary.skipped).toHaveLength(5);
    expect(r.summary.skipped[0]).toContain("Renglón 3");
    expect(r.summary.skipped.join("\n")).toMatch(/precio no válido/);
    expect(r.summary.skipped.join("\n")).toMatch(/repetido/);
    expect(r.summary.warnings).toEqual(["Renglón 2: el modificador «Salsas» no existe. Créalo en la pestaña Modificadores y vuelve a importar."]);
    expect((await tree(w)).categories[0]!.items.find((i) => i.name === "Pastor")!.priceCents).toBe(1800); // el primero manda
  });

  it("acepta el formato de Excel en español (punto y coma, coma decimal, BOM, acentos)", async () => {
    const w = await restaurant();
    const csv = "﻿Categoría;Nombre;Precio;Disponible\r\nTacos;Pastor;18,50;Sí\r\nTacos;Suadero;20,00;agotado\r\n";
    const r = ok(await importMenuCsv(dbs.app.db, w.agent, csv));
    expect(r.summary).toMatchObject({ itemsCreated: 2, skipped: [] });
    expect((await tree(w)).categories[0]!.items.map((i) => [i.name, i.priceCents, i.available])).toEqual([["Pastor", 1850, true], ["Suadero", 2000, false]]);
  });

  it("rechaza archivos sin lo indispensable, vacios o demasiado grandes", async () => {
    const w = await restaurant();
    const bad = (csv: string) => importMenuCsv(dbs.app.db, w.agent, csv);
    expect(await bad("")).toMatchObject({ ok: false, error: "invalid" });
    expect(await bad("   \n  ")).toMatchObject({ ok: false, error: "invalid" });
    expect(await bad("nombre,precio\nA,1")).toMatchObject({ ok: false, error: "invalid", details: [expect.stringContaining("categoria")] });
    expect(await bad("categoria,nombre,precio")).toMatchObject({ ok: false, error: "invalid" });
    const many = "categoria,nombre,precio\n" + Array.from({ length: 501 }, (_, i) => `C,P${i},1`).join("\n");
    expect(await bad(many)).toMatchObject({ ok: false, error: "invalid", details: [expect.stringContaining("500")] });
    expect(await bad("categoria,nombre,precio\n" + "x".repeat(300_001))).toMatchObject({ ok: false, error: "invalid" });
    expect((await tree(w)).categories).toEqual([]);
  });

  it("lo exportado se puede volver a importar y queda igual (incluso en otro negocio)", async () => {
    const a = await withGroups();
    ok(await importMenuCsv(dbs.app.db, a.agent, CSV));
    // Un nombre que Excel tomaria por formula se protege al exportar y se recupera al importar.
    const cat = (await tree(a)).categories[0]!.id;
    ok(await saveItem(dbs.app.db, a.agent, { categoryId: cat, name: "-Especial", description: 'Con "todo", picante', price: 50 }));
    const exported = ok(await exportMenuCsv(dbs.app.db, a.viewer)).csv;
    expect(exported).toContain("'-Especial");

    const b = await withGroups();
    expect(ok(await importMenuCsv(dbs.app.db, b.agent, exported)).summary).toMatchObject({ itemsCreated: 5, skipped: [], warnings: [] });
    const shape = async (w: World) => (await tree(w)).categories.map((c) => ({ c: c.name, items: c.items.map((i) => [i.name, i.description, i.priceCents, i.available, i.groupIds.length]) }));
    expect(await shape(b)).toEqual(await shape(a));
  });
});
