import { describe, expect, it } from "vitest";
import { parseCsv, parsePriceToCents, toCsv, unguard } from "../src/csv";

describe("lector de CSV", () => {
  it("lee comas, comillas, comillas dobles y saltos de linea dentro de comillas", () => {
    const r = parseCsv('categoria,nombre,descripcion\r\nTacos,"Al pastor, con piña","Dice ""el rey""\nde la casa"\n\nBebidas,Agua,\n');
    expect(r.delimiter).toBe(",");
    expect(r.rows).toEqual([
      ["categoria", "nombre", "descripcion"],
      ["Tacos", "Al pastor, con piña", 'Dice "el rey"\nde la casa'],
      ["Bebidas", "Agua", ""],
    ]);
  });

  it("detecta punto y coma (Excel en español) y tabulador, y quita el BOM", () => {
    expect(parseCsv("﻿categoria;nombre;precio\nTacos;Pastor;85,50").rows).toEqual([["categoria", "nombre", "precio"], ["Tacos", "Pastor", "85,50"]]);
    expect(parseCsv("a\tb\nc\td")).toMatchObject({ delimiter: "\t", rows: [["a", "b"], ["c", "d"]] });
    // Una coma dentro de comillas no cuenta para elegir el separador.
    expect(parseCsv('"a,b,c";d\n1;2').delimiter).toBe(";");
  });

  it("acepta un archivo sin salto de linea final, con CR solo, y vacio", () => {
    expect(parseCsv("a,b\r1,2").rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a,b").rows).toEqual([["a", "b"]]);
    expect(parseCsv("").rows).toEqual([]);
    expect(parseCsv("\n\n  ,  \n").rows).toEqual([]);
  });
});

describe("escritor de CSV", () => {
  it("pone comillas cuando hace falta y lleva BOM y CRLF", () => {
    const out = toCsv([["a", "b,c", 'd"e', "f\ng"], ["1", "2", "3", "4"]]);
    expect(out.startsWith("﻿")).toBe(true);
    expect(out).toContain('a,"b,c","d""e","f\ng"\r\n1,2,3,4\r\n');
    expect(parseCsv(out).rows).toEqual([["a", "b,c", 'd"e', "f\ng"], ["1", "2", "3", "4"]]);
  });

  it("protege las celdas que Excel tomaria por formula, y se pueden volver a importar iguales", () => {
    const out = toCsv([["=SUMA(A1)", "+52 999", "-Pizza", "@x", "normal"]]);
    expect(out).toContain("'=SUMA(A1),'+52 999,'-Pizza,'@x,normal");
    const back = parseCsv(out).rows[0]!.map(unguard);
    expect(back).toEqual(["=SUMA(A1)", "+52 999", "-Pizza", "@x", "normal"]);
    expect(unguard("'normal")).toBe("'normal"); // un apostrofo cualquiera no se toca
  });
});

describe("precios", () => {
  it("entiende los formatos que escribe la gente", () => {
    const ok: Array<[string, number]> = [
      ["85", 8500],
      ["$85", 8500],
      ["$ 85.50", 8550],
      ["85,50", 8550],
      ["$1,250.00", 125000],
      ["1.250,00", 125000],
      ["1,250", 125000],
      ["85 pesos", 8500],
      ["MXN 120", 12000],
      ["0", 0],
      ["0.5", 50],
    ];
    for (const [raw, cents] of ok) expect(parsePriceToCents(raw), raw).toBe(cents);
  });

  it("rechaza lo que no es un precio", () => {
    for (const bad of ["", "gratis", "-5", "abc85", "85-", "8 5 5x", "1e5", "999999999"]) expect(parsePriceToCents(bad), bad).toBeNull();
  });
});
