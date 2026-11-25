import { describe, expect, it } from "vitest";
import { STARTER_MENUS, starterMenuFor } from "../src/starter-menus";
import { VERTICAL_IDS } from "../src/verticals";

describe("menus de arranque", () => {
  it("hay uno por cada giro de restaurante y ninguno para los demas", () => {
    expect(Object.keys(STARTER_MENUS).sort()).toEqual(["pizzeria", "restaurante", "taqueria"]);
    for (const id of Object.keys(STARTER_MENUS)) expect(VERTICAL_IDS as readonly string[]).toContain(id);
    expect(starterMenuFor("dental")).toBeNull();
    expect(starterMenuFor(null)).toBeNull();
    expect(starterMenuFor("taqueria")?.title).toBe("Taquería");
  });

  for (const [id, menu] of Object.entries(STARTER_MENUS)) {
    it(`${id}: datos validos (precios, nombres unicos, grupos que existen, opciones sin repetir)`, () => {
      const keys = new Set(menu.groups.map((g) => g.key));
      expect(keys.size).toBe(menu.groups.length);
      expect(new Set(menu.groups.map((g) => g.name.toLowerCase())).size).toBe(menu.groups.length);
      for (const g of menu.groups) {
        expect(g.options.length).toBeGreaterThan(0);
        expect(new Set(g.options.map((o) => o.name.toLowerCase())).size).toBe(g.options.length);
        for (const o of g.options) expect(o.extra ?? 0).toBeGreaterThanOrEqual(0);
        if (g.multiple && g.maxChoices) expect(g.maxChoices).toBeLessThanOrEqual(g.options.length);
      }
      expect(new Set(menu.categories.map((c) => c.name.toLowerCase())).size).toBe(menu.categories.length);
      for (const c of menu.categories) {
        expect(c.items.length).toBeGreaterThan(0);
        expect(new Set(c.items.map((i) => i.name.toLowerCase())).size).toBe(c.items.length);
        for (const i of c.items) {
          expect(i.price).toBeGreaterThan(0);
          expect(i.price).toBeLessThan(2000);
          for (const k of i.groups ?? []) expect(keys.has(k)).toBe(true);
        }
      }
    });
  }
});
