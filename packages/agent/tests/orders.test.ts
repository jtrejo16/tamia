import type { MenuData, MenuGroupRow } from "@empleado/db";
import { describe, expect, it } from "vitest";
import { MAX_ORDER_CENTS, cartKey, deliveryQuote, describeLine, matchZone, openStatus, priceCart, type HoursWindow } from "../src/orders";

const group = (over: Partial<MenuGroupRow> & { id: string; name: string }): MenuGroupRow => ({ required: false, multiple: false, maxChoices: null, options: [], ...over });
const opt = (id: string, name: string, priceDeltaCents = 0, available = true) => ({ id, name, priceDeltaCents, available });

const size = group({ id: "g-size", name: "Tamaño", required: true, options: [opt("o-chica", "Chica"), opt("o-grande", "Grande", 6000)] });
const extras = group({ id: "g-extras", name: "Extras", multiple: true, maxChoices: 2, options: [opt("o-queso", "Queso", 1500), opt("o-champi", "Champiñones", 1200), opt("o-jala", "Jalapeños", 1000), opt("o-piña", "Piña", 1200, false)] });

const item = (id: string, name: string, priceCents: number, over: object = {}) => ({ id, categoryId: "c1", name, description: null, priceCents, available: true, groupIds: [] as string[], ...over });
const MENU: MenuData = {
  groups: [size, extras],
  categories: [
    {
      id: "c1",
      name: "Menú",
      items: [item("i-pizza", "Hawaiana", 9900, { groupIds: ["g-size", "g-extras"] }), item("i-taco", "Taco al pastor", 1800), item("i-agotado", "Mexicana", 14900, { available: false }), item("i-caro", "Cena para muchos", 1_000_000)],
    },
  ],
};

const ok = (r: ReturnType<typeof priceCart>) => {
  expect(r.ok).toBe(true);
  return r as Extract<ReturnType<typeof priceCart>, { ok: true }>;
};
const err = (r: ReturnType<typeof priceCart>) => {
  expect(r.ok).toBe(false);
  return (r as Extract<ReturnType<typeof priceCart>, { ok: false }>).result as Record<string, any>;
};

describe("armar el carrito con el menu real", () => {
  it("calcula los totales en centavos: (precio base + modificadores) × cantidad", () => {
    const r = ok(priceCart(MENU, [
      { platillo_id: "i-pizza", cantidad: 2, opciones_ids: ["o-grande", "o-queso"], notas: " sin cebolla " },
      { platillo_id: "i-taco", cantidad: 3 },
    ]));
    expect(r.lines[0]).toMatchObject({ name: "Hawaiana", unitPriceCents: 9900, quantity: 2, notes: "sin cebolla", lineTotalCents: (9900 + 6000 + 1500) * 2 });
    expect(r.lines[0]!.modifiers.map((m) => [m.groupName, m.optionName, m.priceDeltaCents])).toEqual([["Tamaño", "Grande", 6000], ["Extras", "Queso", 1500]]);
    expect(r.lines[1]).toMatchObject({ unitPriceCents: 1800, quantity: 3, lineTotalCents: 5400, notes: null, modifiers: [] });
    expect(r.subtotalCents).toBe(34800 + 5400);
  });

  it("exige los modificadores obligatorios y dice cuales son", () => {
    const e = err(priceCart(MENU, [{ platillo_id: "i-pizza", cantidad: 1 }]));
    expect(e).toMatchObject({ error: "falta_opcion_obligatoria", platillo: "Hawaiana", grupo: "Tamaño", opciones: ["Chica", "Grande"] });
    expect(e.instruccion).toContain("Chica, Grande");
  });

  it("respeta una sola opcion, el maximo de las multiples, y que las opciones sean del platillo y esten disponibles", () => {
    expect(err(priceCart(MENU, [{ platillo_id: "i-pizza", cantidad: 1, opciones_ids: ["o-chica", "o-grande"] }])).error).toBe("demasiadas_opciones");
    expect(err(priceCart(MENU, [{ platillo_id: "i-pizza", cantidad: 1, opciones_ids: ["o-chica", "o-queso", "o-champi", "o-jala"] }]))).toMatchObject({ error: "demasiadas_opciones", maximo: 2 });
    ok(priceCart(MENU, [{ platillo_id: "i-pizza", cantidad: 1, opciones_ids: ["o-chica", "o-queso", "o-champi"] }]));
    expect(err(priceCart(MENU, [{ platillo_id: "i-pizza", cantidad: 1, opciones_ids: ["o-chica", "o-piña"] }]))).toMatchObject({ error: "opcion_agotada", opcion: "Piña" });
    // Una opcion de otro platillo (el taco no tiene grupos) o inventada no se acepta.
    expect(err(priceCart(MENU, [{ platillo_id: "i-taco", cantidad: 1, opciones_ids: ["o-queso"] }])).error).toBe("opcion_no_valida");
    expect(err(priceCart(MENU, [{ platillo_id: "i-pizza", cantidad: 1, opciones_ids: ["o-chica", "inventada"] }])).error).toBe("opcion_no_valida");
    // Opciones repetidas cuentan una vez.
    expect(ok(priceCart(MENU, [{ platillo_id: "i-pizza", cantidad: 1, opciones_ids: ["o-chica", "o-chica"] }])).lines[0]!.modifiers).toHaveLength(1);
  });

  it("rechaza platillos que no existen, agotados, cantidades fuera de rango y carritos vacios o enormes", () => {
    expect(err(priceCart(MENU, [])).error).toBe("pedido_vacio");
    expect(err(priceCart(MENU, [{ platillo_id: "nada", cantidad: 1 }])).error).toBe("platillo_no_encontrado");
    expect(err(priceCart(MENU, [{ platillo_id: "i-agotado", cantidad: 1 }]))).toMatchObject({ error: "platillo_agotado", platillo: "Mexicana" });
    for (const cantidad of [0, -1, 21, 1.5, Number.NaN]) expect(err(priceCart(MENU, [{ platillo_id: "i-taco", cantidad }])).error).toBe("cantidad_invalida");
    expect(err(priceCart(MENU, Array.from({ length: 16 }, () => ({ platillo_id: "i-taco", cantidad: 1 })))).error).toBe("pedido_muy_grande");
    ok(priceCart(MENU, Array.from({ length: 15 }, () => ({ platillo_id: "i-taco", cantidad: 1 }))));
    // Mas del tope de dinero: lo atiende una persona.
    const big = err(priceCart(MENU, [{ platillo_id: "i-caro", cantidad: 2 }]));
    expect(big.error).toBe("pedido_muy_grande");
    expect(2_000_000).toBeGreaterThan(MAX_ORDER_CENTS);
  });

  it("describe cada partida como se le repite al cliente", () => {
    const r = ok(priceCart(MENU, [{ platillo_id: "i-pizza", cantidad: 2, opciones_ids: ["o-grande"], notas: "sin cebolla" }]));
    expect(describeLine(r.lines[0]!)).toBe("2 × Hawaiana (Tamaño: Grande) — sin cebolla: $318 MXN");
    expect(describeLine(ok(priceCart(MENU, [{ platillo_id: "i-taco", cantidad: 1 }])).lines[0]!)).toBe("1 × Taco al pastor: $18 MXN");
  });
});

describe("huella del carrito (contra pedidos duplicados)", () => {
  const key = (cart: Parameters<typeof priceCart>[1], pay = "efectivo", notes: string | null = null) => cartKey(ok(priceCart(MENU, cart)).lines, pay, notes);

  it("el mismo pedido da la misma huella sin importar el orden; cualquier cambio la cambia", () => {
    const a = key([{ platillo_id: "i-pizza", cantidad: 1, opciones_ids: ["o-chica", "o-queso"] }, { platillo_id: "i-taco", cantidad: 2 }]);
    expect(key([{ platillo_id: "i-taco", cantidad: 2 }, { platillo_id: "i-pizza", cantidad: 1, opciones_ids: ["o-queso", "o-chica"] }])).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(key([{ platillo_id: "i-pizza", cantidad: 1, opciones_ids: ["o-chica", "o-queso"] }, { platillo_id: "i-taco", cantidad: 3 }])).not.toBe(a);
    expect(key([{ platillo_id: "i-pizza", cantidad: 1, opciones_ids: ["o-grande", "o-queso"] }, { platillo_id: "i-taco", cantidad: 2 }])).not.toBe(a);
    expect(key([{ platillo_id: "i-pizza", cantidad: 1, opciones_ids: ["o-chica", "o-queso"] }, { platillo_id: "i-taco", cantidad: 2 }], "tarjeta")).not.toBe(a);
    expect(key([{ platillo_id: "i-pizza", cantidad: 1, opciones_ids: ["o-chica", "o-queso"] }, { platillo_id: "i-taco", cantidad: 2 }], "efectivo", "tocar el timbre")).not.toBe(a);
  });
});

describe("horario de apertura", () => {
  // Marzo de 2027. 1-mar = lunes. Merida es UTC-6: 18:00Z = 12:00 local.
  const at = (iso: string) => new Date(iso);
  const TZ = "America/Merida";
  const week = (opens: string, closes: string, days = [1, 2, 3, 4, 5, 6]): HoursWindow[] => days.map((weekday) => ({ weekday, opens, closes }));

  it("sin horario cargado no bloquea: no se puede saber", () => {
    expect(openStatus([], [], at("2027-03-01T18:00:00Z"), TZ)).toEqual({ configured: false, open: true });
  });

  it("dentro y fuera de horario, con la proxima apertura en palabras", () => {
    const h = week("13:00:00", "22:00:00"); // lunes a sabado
    expect(openStatus(h, [], at("2027-03-01T19:00:00Z"), TZ)).toEqual({ configured: true, open: true }); // lunes 13:00
    expect(openStatus(h, [], at("2027-03-02T03:59:00Z"), TZ)).toEqual({ configured: true, open: true }); // lunes 21:59
    expect(openStatus(h, [], at("2027-03-02T04:00:00Z"), TZ)).toMatchObject({ open: false, nextOpenText: "mañana a las 13:00" }); // lunes 22:00 (cierra)
    expect(openStatus(h, [], at("2027-03-01T17:00:00Z"), TZ)).toMatchObject({ open: false, nextOpenText: "hoy a las 13:00" }); // lunes 11:00
    // Domingo (2027-03-07): sin turno, abre el lunes.
    expect(openStatus(h, [], at("2027-03-07T18:00:00Z"), TZ)).toMatchObject({ open: false, nextOpenText: "mañana a las 13:00" });
    // Viernes tarde cerrado el sabado... y el sabado abierto: de viernes 22:00 a sabado, abre "mañana".
    expect(openStatus(week("13:00:00", "22:00:00", [1, 6]), [], at("2027-03-02T18:00:00Z"), TZ)).toMatchObject({ open: false, nextOpenText: "el sábado a las 13:00" }); // martes
  });

  it("un turno que cruza la medianoche (20:00 a 02:00) cubre la madrugada del dia siguiente", () => {
    const h = week("20:00:00", "02:00:00"); // lunes a sabado
    expect(openStatus(h, [], at("2027-03-02T03:00:00Z"), TZ)).toEqual({ configured: true, open: true }); // lunes 21:00
    expect(openStatus(h, [], at("2027-03-02T07:00:00Z"), TZ)).toEqual({ configured: true, open: true }); // martes 01:00 (turno del lunes)
    expect(openStatus(h, [], at("2027-03-02T08:00:00Z"), TZ)).toMatchObject({ open: false, nextOpenText: "hoy a las 20:00" }); // martes 02:00 ya cerro
    expect(openStatus(h, [], at("2027-03-07T07:00:00Z"), TZ)).toEqual({ configured: true, open: true }); // domingo 01:00 (turno del sabado)
    expect(openStatus(h, [], at("2027-03-08T03:00:00Z"), TZ)).toMatchObject({ open: false, nextOpenText: "mañana a las 20:00" }); // domingo 21:00: no abre domingos
    expect(openStatus(h, [], at("2027-03-08T07:00:00Z"), TZ)).toMatchObject({ open: false, nextOpenText: "hoy a las 20:00" }); // lunes 01:00: el domingo no hubo turno
  });

  it("los dias de cierre cuentan como cerrado, y el turno de madrugada de un festivo no aplica", () => {
    const h = week("13:00:00", "22:00:00");
    expect(openStatus(h, ["2027-03-01"], at("2027-03-01T19:00:00Z"), TZ)).toMatchObject({ open: false, nextOpenText: "mañana a las 13:00" });
  });
});

describe("zonas de entrega", () => {
  const z = (id: string, name: string, feeCents = 3000, minOrderCents = 0, active = true) => ({ id, name, feeCents, minOrderCents, active });
  const zones = [z("1", "Centro"), z("2", "Francisco de Montejo"), z("3", "Montejo Norte"), z("4", "Cerrada", 1000, 0, false)];

  it("encuentra la zona sin importar mayusculas, acentos ni adornos", () => {
    expect(matchZone(zones, "centro")?.id).toBe("1");
    expect(matchZone(zones, "Col. CÉNTRO, Mérida")?.id).toBe("1");
    expect(matchZone(zones, "francisco de montejo")?.id).toBe("2");
    expect(matchZone(zones, "Fracc. Francisco de Montejo 2")?.id).toBe("2");
  });

  it("prefiere el nombre exacto y, entre varios que caben, el mas especifico; lo ambiguo o inactivo no coincide", () => {
    expect(matchZone(zones, "Montejo Norte")?.id).toBe("3");
    expect(matchZone(zones, "Montejo")).toBeNull(); // cabe en dos zonas: no se adivina
    expect(matchZone(zones, "Cerrada")).toBeNull(); // inactiva
    expect(matchZone(zones, "Itzimna")).toBeNull();
    expect(matchZone(zones, "  ")).toBeNull();
    expect(matchZone(zones, "ce")).toBeNull();
  });

  it("el envio es el de la zona, gratis desde el monto, y el minimo es el mayor entre el general y el de la zona", () => {
    const settings = { minOrderCents: 5000, freeDeliveryFromCents: 20000 };
    expect(deliveryQuote(settings, { feeCents: 3000, minOrderCents: 0 }, 10000)).toEqual({ feeCents: 3000, minOrderCents: 5000, free: false });
    expect(deliveryQuote(settings, { feeCents: 3000, minOrderCents: 15000 }, 10000)).toMatchObject({ minOrderCents: 15000 });
    expect(deliveryQuote(settings, { feeCents: 3000, minOrderCents: 0 }, 20000)).toMatchObject({ feeCents: 0, free: true });
    expect(deliveryQuote({ minOrderCents: 0, freeDeliveryFromCents: null }, { feeCents: 3000, minOrderCents: 0 }, 999_999)).toMatchObject({ feeCents: 3000, free: false });
  });

  it("la huella del pedido distingue la direccion de entrega", () => {
    const lines = (priceCart(MENU, [{ platillo_id: "i-taco", cantidad: 1 }]) as { lines: Parameters<typeof cartKey>[0] }).lines;
    expect(cartKey(lines, "efectivo", null, { zone: "Centro", address: "Calle 1" })).not.toBe(cartKey(lines, "efectivo", null));
    expect(cartKey(lines, "efectivo", null, { zone: "Centro", address: "Calle 1" })).toBe(cartKey(lines, "efectivo", null, { zone: "Centro", address: "CALLE 1" }));
    expect(cartKey(lines, "efectivo", null, { zone: "Centro", address: "Calle 1" })).not.toBe(cartKey(lines, "efectivo", null, { zone: "Centro", address: "Calle 2" }));
  });
});
