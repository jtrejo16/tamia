import { createHash } from "node:crypto";
import type { DeliveryZoneRow, MenuData, MenuGroupRow, MenuItemRow, RestaurantSettingsRow } from "@empleado/db";
import { addDays, localDate, localParts, parseHM, weekdayOf, type LocalDate } from "@empleado/scheduling";
import { formatMoney, weekdayName } from "./format";
import type { ToolResult } from "./types";

/**
 * Pedidos del restaurante: la parte que NO puede depender del modelo. Arma el carrito contra el menu REAL, valida los
 * modificadores y calcula los totales en centavos. El modelo solo dice que quiere el cliente; el precio lo pone el codigo.
 */

export const MAX_LINES = 15;
export const MAX_QUANTITY = 20;
/** Pedidos mas grandes (eventos, comidas para muchos) los atiende una persona. */
export const MAX_ORDER_CENTS = 1_500_000;

export interface CartLineInput {
  platillo_id: string;
  cantidad: number;
  opciones_ids?: string[];
  notas?: string;
}

export interface PricedModifier {
  optionId: string;
  groupName: string;
  optionName: string;
  priceDeltaCents: number;
}

export interface PricedLine {
  itemId: string;
  name: string;
  /** Precio base del platillo (sin modificadores). */
  unitPriceCents: number;
  quantity: number;
  notes: string | null;
  modifiers: PricedModifier[];
  /** (precio base + modificadores) × cantidad. */
  lineTotalCents: number;
}

export type CartResult = { ok: true; lines: PricedLine[]; subtotalCents: number } | { ok: false; result: ToolResult };

const money = (cents: number) => formatMoney(cents);
const bad = (error: string, extra: Record<string, unknown>): CartResult => ({ ok: false, result: { error, ...extra } });

/** Arma y valida el carrito contra el menu. Cualquier cosa fuera de lo que el menu permite se rechaza con un motivo claro. */
export function priceCart(menu: MenuData, input: CartLineInput[]): CartResult {
  if (input.length === 0) return bad("pedido_vacio", { instruccion: "Falta qué quiere pedir el cliente." });
  if (input.length > MAX_LINES) return bad("pedido_muy_grande", { instruccion: `Máximo ${MAX_LINES} platillos distintos por pedido. Un pedido más grande lo atiende una persona: usa escalar_a_humano.` });

  const items = new Map<string, MenuItemRow>();
  for (const c of menu.categories) for (const i of c.items) items.set(i.id, i);
  const groups = new Map<string, MenuGroupRow>(menu.groups.map((g) => [g.id, g]));

  const lines: PricedLine[] = [];
  for (const [n, line] of input.entries()) {
    const item = items.get(line.platillo_id);
    if (!item) return bad("platillo_no_encontrado", { articulo: n + 1, instruccion: "Ese platillo no existe en el menú. Búscalo de nuevo con consultar_menu y usa su platillo_id exacto." });
    if (!item.available) return bad("platillo_agotado", { platillo: item.name, instruccion: `«${item.name}» está agotado hoy. Díselo al cliente y ofrece otra cosa del menú.` });
    if (!Number.isInteger(line.cantidad) || line.cantidad < 1 || line.cantidad > MAX_QUANTITY) {
      return bad("cantidad_invalida", { platillo: item.name, instruccion: `La cantidad de «${item.name}» debe ser de 1 a ${MAX_QUANTITY}. Un pedido más grande lo atiende una persona.` });
    }

    const chosen = [...new Set(line.opciones_ids ?? [])];
    const itemGroups = item.groupIds.flatMap((id) => (groups.has(id) ? [groups.get(id)!] : []));
    const modifiers: PricedModifier[] = [];
    for (const optionId of chosen) {
      const group = itemGroups.find((g) => g.options.some((o) => o.id === optionId));
      const option = group?.options.find((o) => o.id === optionId);
      if (!group || !option) return bad("opcion_no_valida", { platillo: item.name, instruccion: `Una de las opciones no pertenece a «${item.name}». Usa solo los opcion_id que devolvió consultar_menu para ese platillo.` });
      if (!option.available) return bad("opcion_agotada", { platillo: item.name, opcion: option.name, instruccion: `«${option.name}» está agotada hoy. Ofrece otra opción del mismo grupo.` });
      modifiers.push({ optionId, groupName: group.name, optionName: option.name, priceDeltaCents: option.priceDeltaCents });
    }
    for (const group of itemGroups) {
      const count = modifiers.filter((m) => group.options.some((o) => o.id === m.optionId)).length;
      const names = group.options.filter((o) => o.available).map((o) => o.name);
      if (group.required && count === 0) return bad("falta_opcion_obligatoria", { platillo: item.name, grupo: group.name, opciones: names, instruccion: `Pregúntale al cliente ${group.name.toLowerCase()} de «${item.name}» (obligatorio): ${names.join(", ")}.` });
      if (!group.multiple && count > 1) return bad("demasiadas_opciones", { platillo: item.name, grupo: group.name, instruccion: `En «${group.name}» solo se puede elegir UNA opción.` });
      if (group.multiple && group.maxChoices && count > group.maxChoices) return bad("demasiadas_opciones", { platillo: item.name, grupo: group.name, maximo: group.maxChoices, instruccion: `En «${group.name}» se pueden elegir máximo ${group.maxChoices}.` });
    }

    const delta = modifiers.reduce((s, m) => s + m.priceDeltaCents, 0);
    lines.push({
      itemId: item.id,
      name: item.name,
      unitPriceCents: item.priceCents,
      quantity: line.cantidad,
      notes: line.notas?.trim() ? line.notas.trim().slice(0, 200) : null,
      modifiers,
      lineTotalCents: (item.priceCents + delta) * line.cantidad,
    });
  }

  const subtotalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  if (subtotalCents > MAX_ORDER_CENTS) return bad("pedido_muy_grande", { instruccion: `Un pedido de más de ${money(MAX_ORDER_CENTS)} lo atiende una persona: usa escalar_a_humano.` });
  return { ok: true, lines, subtotalCents };
}

/** "2 × Taco al pastor (Tortilla: Harina) — sin cebolla: $38 MXN". Es lo que se repite al cliente para que confirme. */
export function describeLine(l: Pick<PricedLine, "name" | "quantity" | "modifiers" | "notes" | "lineTotalCents">): string {
  const mods = l.modifiers.length > 0 ? ` (${l.modifiers.map((m) => `${m.groupName}: ${m.optionName}`).join("; ")})` : "";
  return `${l.quantity} × ${l.name}${mods}${l.notes ? ` — ${l.notes}` : ""}: ${money(l.lineTotalCents)}`;
}

/**
 * Huella del carrito: el mismo pedido (mismos platillos, opciones, cantidades, pago y notas) da la misma huella.
 * Evita crear dos veces un pedido si se repite la confirmacion. El orden de las opciones no importa.
 */
export function cartKey(lines: PricedLine[], paymentMethod: string, notes: string | null, delivery: { zone: string; address: string } | null = null): string {
  const canon = lines
    .map((l) => [l.itemId, l.quantity, [...l.modifiers.map((m) => m.optionId)].sort(), l.notes ?? ""])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify([canon, paymentMethod, notes ?? "", delivery ? [delivery.zone, delivery.address.toLowerCase()] : null])).digest("hex").slice(0, 32);
}

// ------------------------------------------------------------------------------------------ domicilio

const normText = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Busca la zona de entrega a partir de la colonia que dio el cliente. Coincide sin importar mayusculas ni acentos: primero el
 * nombre exacto; si no, una zona cuyo nombre aparezca dentro de lo escrito ("col. Centro, Merida" → "Centro") o que lo contenga.
 * Solo cuentan las zonas activas. Devuelve null si ninguna encaja (el asistente debe decir cuales cubre el restaurante).
 */
export function matchZone(zones: DeliveryZoneRow[], text: string): DeliveryZoneRow | null {
  const q = normText(text);
  if (q.length < 3) return null;
  const active = zones.filter((z) => z.active);
  const exact = active.find((z) => normText(z.name) === q);
  if (exact) return exact;
  const inside = active.filter((z) => ` ${q} `.includes(` ${normText(z.name)} `)).sort((a, b) => b.name.length - a.name.length);
  if (inside[0]) return inside[0];
  const contains = active.filter((z) => ` ${normText(z.name)} `.includes(` ${q} `));
  return contains.length === 1 ? contains[0]! : null;
}

export interface DeliveryQuote {
  feeCents: number;
  /** Pedido minimo que aplica a esta zona (el mayor entre el general y el de la zona). */
  minOrderCents: number;
  free: boolean;
}

export function deliveryQuote(settings: Pick<RestaurantSettingsRow, "minOrderCents" | "freeDeliveryFromCents">, zone: Pick<DeliveryZoneRow, "feeCents" | "minOrderCents">, subtotalCents: number): DeliveryQuote {
  const free = settings.freeDeliveryFromCents !== null && settings.freeDeliveryFromCents > 0 && subtotalCents >= settings.freeDeliveryFromCents;
  return { feeCents: free ? 0 : zone.feeCents, minOrderCents: Math.max(settings.minOrderCents, zone.minOrderCents), free };
}

// ------------------------------------------------------------------------------------------ horario

export interface HoursWindow {
  weekday: number;
  opens: string;
  closes: string;
}

export interface OpenStatus {
  /** Hay horario cargado. Sin horario no se puede saber si esta abierto: no se bloquea nada. */
  configured: boolean;
  open: boolean;
  nextOpenText?: string;
}

const dateKey = (d: LocalDate) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

/**
 * ¿Esta abierto el restaurante ahora? Usa el horario general del negocio y sus dias de cierre. Soporta horarios que cruzan la
 * medianoche (por ejemplo de 20:00 a 02:00, comun en taquerias): ese turno cuenta tambien para la madrugada del dia siguiente.
 */
export function openStatus(hours: HoursWindow[], holidays: string[], now: Date, timeZone: string): OpenStatus {
  if (hours.length === 0) return { configured: false, open: true };
  const today = localDate(now, timeZone);
  const { hour, minute } = localParts(now, timeZone);
  const minutes = hour * 60 + minute;
  const closed = new Set(holidays);

  const windowsOf = (date: LocalDate) => (closed.has(dateKey(date)) ? [] : hours.filter((h) => h.weekday === weekdayOf(date)).map((h) => ({ from: parseHM(h.opens), to: parseHM(h.closes) })));
  const todayW = windowsOf(today);
  const yesterdayW = windowsOf(addDays(today, -1));

  const open =
    todayW.some((w) => (w.to > w.from ? minutes >= w.from && minutes < w.to : minutes >= w.from)) ||
    yesterdayW.some((w) => w.to <= w.from && minutes < w.to); // la madrugada del turno de ayer
  if (open) return { configured: true, open: true };

  for (let i = 0; i <= 7; i++) {
    const date = addDays(today, i);
    const starts = windowsOf(date).map((w) => w.from).filter((from) => i > 0 || from > minutes).sort((a, b) => a - b);
    if (starts.length === 0) continue;
    const t = `${String(Math.floor(starts[0]! / 60)).padStart(2, "0")}:${String(starts[0]! % 60).padStart(2, "0")}`;
    const when = i === 0 ? "hoy" : i === 1 ? "mañana" : `el ${weekdayName(weekdayOf(date))}`;
    return { configured: true, open: false, nextOpenText: `${when} a las ${t}` };
  }
  return { configured: true, open: false };
}

