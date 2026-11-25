import { describe, expect, it } from "vitest";
import { DEFAULT_MODULES, VERTICAL_MODULES, hasModule, modulesFor } from "../src/modules";

describe("modulos de un negocio", () => {
  it("un giro sin modulos propios (o desconocido, o sin giro) conserva el de citas: los negocios actuales no cambian", () => {
    for (const v of ["dental", "salud", "belleza", "generico", "giro-que-no-existe", "", null, undefined]) expect(modulesFor(v)).toEqual(["citas"]);
    expect(DEFAULT_MODULES).toEqual(["citas"]);
    expect(VERTICAL_MODULES).toEqual({});
  });

  it("profile.modules anula el del giro: enciende un modulo a un negocio concreto, o lo deja solo con el nucleo", () => {
    expect(modulesFor("dental", ["restaurante"])).toEqual(["restaurante"]);
    expect(modulesFor("dental", ["citas", "restaurante"])).toEqual(["citas", "restaurante"]);
    expect(modulesFor("dental", [])).toEqual([]);
  });

  it("ignora nombres desconocidos o repetidos, y un valor que no es lista", () => {
    expect(modulesFor("dental", ["restaurante", "nada", 7, "restaurante"])).toEqual(["restaurante"]);
    for (const bad of ["restaurante", 5, {}, null, undefined]) expect(modulesFor("dental", bad)).toEqual(["citas"]);
  });

  it("hasModule", () => {
    expect(hasModule(["citas"], "citas")).toBe(true);
    expect(hasModule(["citas"], "restaurante")).toBe(false);
  });
});
