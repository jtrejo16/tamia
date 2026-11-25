import {
  PAYMENT_METHODS,
  auditLog,
  businessHolidays,
  businessHours,
  channels,
  conversations,
  loadDeliveryZones,
  loadMenu,
  loadRestaurantSettings,
  orderItemModifiers,
  orderItems,
  orders,
  withTenant,
  type DeliveryZoneRow,
  type MenuCategoryRow,
  type MenuData,
  type MenuGroupRow,
  type MenuItemRow,
  type OrderStatus,
  type RestaurantSettingsRow,
} from "@empleado/db";
import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { formatLocal, formatMoney } from "./format";
import { defineModuleTool, registerModulePrompt, registerModuleTools } from "./modules";
import { cartKey, deliveryQuote, describeLine, matchZone, openStatus, priceCart } from "./orders";
import { confirmationGate, finishMutation, proposeAction } from "./tools";
import type { ToolResult, TurnContext } from "./types";

/**
 * Modulo "restaurante" del agente: consultar el menu y tomar pedidos para recoger. El menu y los pedidos viven en la base de
 * datos: nunca van dentro del prompt, y los totales los calcula el codigo (ver orders.ts), no el modelo.
 * Este archivo se carga una sola vez, desde index.ts, y registra el modulo.
 */

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const words = (s: string) => norm(s).split(/[^a-z0-9ñ]+/).filter((w) => w.length > 0);

/** Platillos que se listan sin busqueda; con mas, solo las categorias (para no soltar una lista enorme). */
const OVERVIEW_LIMIT = 60;
const MAX_RESULTS = 8;

const money = (cents: number) => formatMoney(cents);

/** Lo que el modelo necesita saber de las condiciones de pedido. */
function orderInfo(s: RestaurantSettingsRow, zones: DeliveryZoneRow[] = []): Record<string, unknown> {
  const active = zones.filter((z) => z.active);
  const delivery = s.deliveryEnabled && active.length > 0;
  return {
    ...(s.acceptingOrders ? {} : { pedidos_pausados: true }),
    formas_de_pago: s.paymentMethods,
    tiempo_de_preparacion_minutos: s.prepMinutes,
    ...(s.minOrderCents > 0 ? { pedido_minimo: money(s.minOrderCents) } : {}),
    para_recoger_en_el_local: true,
    ...(delivery
      ? {
          a_domicilio: {
            tiempo_aproximado_minutos: s.deliveryMinutes,
            zonas: active.map((z) => ({ nombre: z.name, costo_de_envio: money(z.feeCents), ...(z.minOrderCents > s.minOrderCents ? { pedido_minimo: money(z.minOrderCents) } : {}) })),
            ...(s.freeDeliveryFromCents ? { envio_gratis_desde: money(s.freeDeliveryFromCents) } : {}),
          },
        }
      : { a_domicilio: "no disponible" }),
  };
}

function describeGroup(g: MenuGroupRow) {
  return {
    nombre: g.name,
    obligatorio: g.required,
    ...(g.multiple ? { varias_opciones: true, ...(g.maxChoices ? { maximo: g.maxChoices } : {}) } : { una_sola_opcion: true }),
    opciones: g.options.map((o) => ({
      opcion_id: o.id,
      nombre: o.name,
      ...(o.priceDeltaCents > 0 ? { extra: `+${money(o.priceDeltaCents)}` } : {}),
      ...(o.available ? {} : { agotada: true }),
    })),
  };
}

function describeItem(item: MenuItemRow, category: MenuCategoryRow, groups: Map<string, MenuGroupRow>) {
  return {
    platillo_id: item.id,
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
      instruccion: "Resume por categorías y ofrece dar el detalle (ingredientes, modificadores) de lo que le interese con consultar_menu. Para tomar un pedido, busca cada platillo con consultar_menu: ahí viene su platillo_id.",
    };
  }
  return {
    categorias: menu.categories.map((c) => ({ nombre: c.name, cantidad_de_platillos: c.items.length })),
    instruccion: "El menú es grande: menciona las categorías y pregunta cuál le interesa; luego busca esa categoría con consultar_menu.",
  };
}

export async function consultMenu(menu: MenuData, query: string | undefined, info?: RestaurantSettingsRow, zones: DeliveryZoneRow[] = []): Promise<ToolResult> {
  if (menu.categories.every((c) => c.items.length === 0)) {
    return { error: "menu_vacio", instruccion: "El menú todavía no está cargado. Díselo al cliente con honestidad y usa escalar_a_humano." };
  }
  const extra = info ? { info_de_pedidos: orderInfo(info, zones) } : {};
  const q = words(query ?? "");
  if (q.length === 0) return { ...overview(menu), ...extra };

  const groups = new Map(menu.groups.map((g) => [g.id, g]));
  const category = menu.categories.find((c) => norm(c.name) === norm(query ?? "") || words(c.name).join(" ") === q.join(" "));
  if (category) {
    return {
      categoria: category.name,
      platillos: category.items.map((i) => describeItem(i, category, groups)),
      instruccion: "Presenta los platillos con su precio; da el detalle de los modificadores solo si preguntan.",
      ...extra,
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
      ...extra,
    };
  }
  return {
    resultados: hits.slice(0, MAX_RESULTS).map((h) => describeItem(h.item, h.category, groups)),
    ...(hits.length > MAX_RESULTS ? { hay_mas: hits.length - MAX_RESULTS } : {}),
    instruccion: "Usa SOLO estos datos. Un platillo marcado como agotado no se ofrece. Menciona los modificadores obligatorios y sus costos extra.",
    ...extra,
  };
}

// --------------------------------------------------------------------------------------------- pedidos

const STATUS_TEXT: Record<OrderStatus, string> = {
  new: "recibido (todavía no empieza a prepararse)",
  preparing: "en preparación",
  ready: "listo para recoger",
  on_the_way: "en camino a su domicilio",
  delivered: "entregado",
  cancelled: "cancelado",
};
const statusText = (o: { status: OrderStatus; mode: string }) => (o.status === "ready" && o.mode === "delivery" ? "listo; está por salir a su domicilio" : STATUS_TEXT[o.status]);

const confirmado = z.boolean().default(false).describe("false para obtener el resumen; true SOLO cuando el cliente ya confirmó ese resumen en su mensaje anterior.");

const articulo = z.object({
  platillo_id: z.string().min(1).describe("El platillo_id EXACTO que devolvió consultar_menu"),
  cantidad: z.number().int().min(1).max(20),
  opciones_ids: z.array(z.string().min(1)).max(10).optional().describe("Los opcion_id elegidos de los modificadores de ese platillo (tamaño, extras…). Los obligatorios deben ir."),
  notas: z.string().trim().max(200).optional().describe("Lo especial que pidió para ESTE platillo, con sus palabras: 'sin cebolla', 'bien cocido'…"),
});

/** Canal por el que escribe el cliente (para el tablero y los avisos). */
async function channelOf(tx: Parameters<Parameters<typeof withTenant>[2]>[0], conversationId: string): Promise<string> {
  const [row] = await tx.select({ type: channels.type }).from(conversations).innerJoin(channels, eq(channels.id, conversations.channelId)).where(eq(conversations.id, conversationId));
  return row?.type ?? "whatsapp";
}

/** Argumentos en una forma estable (para que la confirmacion se ligue a ESTE pedido aunque el modelo reordene). */
function stableArgs(args: { articulos: Array<z.infer<typeof articulo>>; forma_de_pago: string; notas?: string; modo?: string; direccion?: string; colonia?: string }) {
  const articulos = args.articulos
    .map((a) => ({ platillo_id: a.platillo_id, cantidad: a.cantidad, opciones_ids: [...new Set(a.opciones_ids ?? [])].sort(), notas: a.notas?.trim() ?? "" }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    articulos,
    forma_de_pago: args.forma_de_pago,
    notas: args.notas?.trim() ?? "",
    modo: args.modo ?? "recoger",
    direccion: args.direccion?.trim() ?? "",
    colonia: args.colonia?.trim() ?? "",
  };
}

async function orderAudit(tx: Parameters<Parameters<typeof withTenant>[2]>[0], ctx: TurnContext, action: string, orderId: string, diff: Record<string, unknown>) {
  await tx.insert(auditLog).values({ tenantId: ctx.tenantId, action, entity: "order", entityId: orderId, diff: { actor: ctx.skipConfirmation ? "bot_aprobado_por_humano" : "bot", ...diff } });
}

const crearPedido = defineModuleTool({
  name: "crear_pedido",
  description:
    "Crea un pedido, PARA RECOGER en el local (modo 'recoger') o A DOMICILIO (modo 'domicilio', solo si info_de_pedidos.a_domicilio lo ofrece; pide calle y número, colonia y referencias). Primero llámala SIN confirmado para obtener el resumen con el total (calculado por el sistema) que debes repetir al cliente; solo cuando el cliente confirme, llámala de nuevo con los mismos datos y confirmado=true. Requiere el nombre y el teléfono del cliente ya guardados.",
  mutating: true,
  schema: z.object({
    articulos: z.array(articulo).min(1).max(15),
    forma_de_pago: z.enum(PAYMENT_METHODS).describe("Cómo va a pagar (al recoger o al recibir). Debe ser una de las formas_de_pago del negocio."),
    modo: z.enum(["recoger", "domicilio"]).default("recoger").describe("recoger = pasa al local; domicilio = se lo llevan."),
    direccion: z.string().trim().max(250).optional().describe("Solo domicilio: calle, número y referencias (entre calles, color de la casa…), con las palabras del cliente."),
    colonia: z.string().trim().max(100).optional().describe("Solo domicilio: colonia o zona. Se compara con las zonas que cubre el restaurante."),
    notas: z.string().trim().max(300).optional().describe("Algo para TODO el pedido, por ejemplo 'recojo en 30 minutos'. No pongas aquí lo de un platillo."),
    confirmado,
  }),
  async execute(args, ctx) {
    const loaded = await withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => ({
      menu: await loadMenu(tx),
      settings: await loadRestaurantSettings(tx),
      hours: await tx.select().from(businessHours).where(isNull(businessHours.staffId)),
      holidays: await tx.select().from(businessHolidays).where(isNull(businessHolidays.staffId)),
      zones: await loadDeliveryZones(tx),
    }));
    const { menu, settings } = loaded;

    if (!settings.acceptingOrders) {
      return { error: "pedidos_pausados", instruccion: "Ahorita no se están tomando pedidos (la cocina está saturada). Díselo con amabilidad, ofrécele intentar en un rato, y no tomes el pedido." };
    }
    const open = openStatus(loaded.hours.map((h) => ({ weekday: h.weekday, opens: h.opens, closes: h.closes })), loaded.holidays.map((h) => String(h.date)), ctx.now, ctx.tenant.timezone);
    if (!open.open) {
      return { error: "cerrado_ahora", ...(open.nextOpenText ? { abre: open.nextOpenText } : {}), instruccion: `El restaurante está cerrado ahora${open.nextOpenText ? ` y abre ${open.nextOpenText}` : ""}. Díselo y no tomes el pedido.` };
    }

    const name = ctx.contact.displayName?.trim();
    if (!name) return { error: "faltan_datos", faltan: ["nombre"], instruccion: "Pide el nombre del cliente (para llamarlo al recoger) y guárdalo con guardar_datos_contacto antes de crear el pedido." };
    if (!ctx.contact.phoneE164) {
      return { error: "faltan_datos", faltan: ["teléfono a 10 dígitos"], instruccion: "Antes de crear el pedido pídele su número de teléfono a 10 dígitos (si es por llamada, número por número, y repítelo para confirmar) y dile que es para avisarle de su pedido. Guárdalo con guardar_datos_contacto (campo telefono)." };
    }
    if (!settings.paymentMethods.includes(args.forma_de_pago)) {
      return { error: "forma_de_pago_no_disponible", formas_de_pago: settings.paymentMethods, instruccion: `Solo aceptan: ${settings.paymentMethods.join(", ")}. Pregúntale con cuál prefiere pagar.` };
    }

    const cart = priceCart(menu, args.articulos);
    if (!cart.ok) return cart.result;
    if (cart.subtotalCents < settings.minOrderCents) {
      return { error: "pedido_minimo", minimo: money(settings.minOrderCents), llevas: money(cart.subtotalCents), instruccion: `El pedido mínimo es de ${money(settings.minOrderCents)} y lleva ${money(cart.subtotalCents)}. Ofrécele agregar algo más.` };
    }

    // A domicilio: la zona sale de la colonia que dio el cliente y el envio lo pone el sistema segun esa zona.
    const delivery = args.modo === "domicilio";
    const address = args.direccion?.trim() ?? "";
    const colonia = args.colonia?.trim() ?? "";
    let zone: DeliveryZoneRow | null = null;
    let feeCents = 0;
    if (delivery) {
      const zones = loaded.zones.filter((z) => z.active);
      if (!settings.deliveryEnabled || zones.length === 0) {
        return { error: "entrega_no_disponible", instruccion: "Este restaurante no hace entregas a domicilio. Ofrécele que pase a recoger su pedido al local." };
      }
      const missing = [...(address.length < 5 ? ["calle y número (y referencias)"] : []), ...(colonia.length < 3 ? ["colonia"] : [])];
      if (missing.length > 0) return { error: "faltan_datos", faltan: missing, instruccion: `Para el domicilio falta: ${missing.join(" y ")}. Pídelo al cliente.` };
      zone = matchZone(zones, colonia);
      if (!zone) {
        return { error: "zona_no_cubierta", zonas: zones.map((z) => z.name), instruccion: `Esa colonia no está en las zonas de entrega. Dile cuáles cubren (${zones.map((z) => z.name).join(", ")}) y ofrécele pasar a recoger.` };
      }
      const quote = deliveryQuote(settings, zone, cart.subtotalCents);
      if (cart.subtotalCents < quote.minOrderCents) {
        return { error: "pedido_minimo", minimo: money(quote.minOrderCents), llevas: money(cart.subtotalCents), instruccion: `Para entregar en ${zone.name} el pedido mínimo es de ${money(quote.minOrderCents)} (sin envío) y lleva ${money(cart.subtotalCents)}. Ofrécele agregar algo más.` };
      }
      feeCents = quote.feeCents;
    }
    const totalCents = cart.subtotalCents + feeCents;

    const notes = args.notas?.trim() || null;
    const minutes = delivery ? settings.deliveryMinutes : settings.prepMinutes;
    const summary = delivery
      ? `Pedido a domicilio: ${cart.lines.map(describeLine).join("; ")}. Subtotal ${money(cart.subtotalCents)}, envío a ${zone!.name} ${feeCents > 0 ? money(feeCents) : "gratis"}. Total ${money(totalCents)}. ` +
        `Pago: ${args.forma_de_pago}${args.forma_de_pago === "efectivo" ? " al recibir" : ""}. A nombre de ${name}. Se entrega en: ${address}, col. ${zone!.name}.` +
        (notes ? ` Nota: ${notes}.` : "") +
        ` Llegará en unos ${minutes} minutos.`
      : `Pedido para recoger en el local: ${cart.lines.map(describeLine).join("; ")}. Total ${money(cart.subtotalCents)}. ` +
        `Pago: ${args.forma_de_pago}${args.forma_de_pago === "efectivo" ? " al recoger" : ""}. A nombre de ${name}.` +
        (notes ? ` Nota: ${notes}.` : "") +
        ` Estará listo en unos ${minutes} minutos.`;

    const stable = stableArgs(args);
    const gate = confirmationGate(ctx, "crear_pedido", stable, args.confirmado, summary);
    if (gate) return gate;
    if (ctx.mode === "dry") return proposeAction(ctx, { tool: "crear_pedido", args: stable, summary });

    const key = cartKey(cart.lines, args.forma_de_pago, notes, delivery ? { zone: zone!.name, address } : null);
    const created = await withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => {
      // Si ya se creo este mismo pedido hace unos minutos (confirmacion repetida), se devuelve ese en vez de duplicarlo.
      const [dup] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.contactId, ctx.contactId), eq(orders.idempotencyKey, key), gte(orders.createdAt, new Date(ctx.now.getTime() - 10 * 60_000))));
      if (dup) return { order: dup, duplicate: true };

      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId}, 0))`); // un numero a la vez por negocio
      const [last] = await tx.select({ n: sql<number>`coalesce(max(${orders.number}), 0)` }).from(orders);
      const channel = await channelOf(tx, ctx.conversationId);
      const [order] = await tx
        .insert(orders)
        .values({
          tenantId: ctx.tenantId,
          number: Number(last?.n ?? 0) + 1,
          contactId: ctx.contactId,
          conversationId: ctx.conversationId,
          channel,
          mode: delivery ? "delivery" : "pickup",
          status: "new",
          customerName: name,
          customerPhone: ctx.contact.phoneE164,
          notes,
          paymentMethod: args.forma_de_pago,
          subtotalCents: cart.subtotalCents,
          deliveryFeeCents: feeCents,
          deliveryAddress: delivery ? address : null,
          deliveryZoneName: zone?.name ?? null,
          totalCents,
          estimatedReadyAt: new Date(ctx.now.getTime() + minutes * 60_000),
          idempotencyKey: key,
          createdAt: ctx.now,
          updatedAt: ctx.now,
        })
        .returning();
      for (const [i, l] of cart.lines.entries()) {
        const [row] = await tx
          .insert(orderItems)
          .values({ tenantId: ctx.tenantId, orderId: order!.id, menuItemId: l.itemId, name: l.name, unitPriceCents: l.unitPriceCents, quantity: l.quantity, lineTotalCents: l.lineTotalCents, notes: l.notes, sortOrder: i })
          .returning({ id: orderItems.id });
        if (l.modifiers.length > 0) {
          await tx.insert(orderItemModifiers).values(l.modifiers.map((m) => ({ tenantId: ctx.tenantId, orderItemId: row!.id, groupName: m.groupName, optionName: m.optionName, priceDeltaCents: m.priceDeltaCents })));
        }
      }
      await orderAudit(tx, ctx, "order.created", order!.id, { number: order!.number, totalCents, channel, mode: delivery ? "delivery" : "pickup" });
      return { order: order!, duplicate: false };
    });
    finishMutation(ctx);
    return {
      ok: true,
      pedido_numero: created.order.number,
      total: money(created.order.totalCents),
      ...(delivery ? { modo: "domicilio", costo_de_envio: money(feeCents), llega_en_minutos: minutes } : { modo: "recoger", listo_en_minutos: minutes }),
      confirmacion: summary,
      ...(created.duplicate ? { nota: "Este pedido ya estaba registrado; no se duplicó." } : {}),
      ...(args.forma_de_pago === "transferencia" && settings.transferInfo ? { datos_para_transferir: settings.transferInfo } : {}),
      instruccion: delivery
        ? "Dile su NÚMERO DE PEDIDO, el total con el envío, la dirección a la que se lleva y en cuánto tiempo llegará. Si paga por transferencia, dale los datos para transferir."
        : "Dile su NÚMERO DE PEDIDO, el total y en cuánto tiempo estará listo para recoger en el local. Si paga por transferencia, dale los datos para transferir.",
    };
  },
});

const estadoPedido = defineModuleTool({
  name: "estado_pedido",
  description: "Consulta los pedidos de las últimas 24 horas del cliente que escribe y en qué van (recibido, en preparación, listo, entregado, cancelado). Úsala para '¿ya está mi pedido?'.",
  mutating: false,
  schema: z.object({}),
  async execute(_args, ctx) {
    const rows = await withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => {
      const list = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.contactId, ctx.contactId), gte(orders.createdAt, new Date(ctx.now.getTime() - 24 * 3_600_000))))
        .orderBy(desc(orders.createdAt))
        .limit(5);
      const items = list.length ? await tx.select().from(orderItems).orderBy(asc(orderItems.sortOrder)) : [];
      return list.map((o) => ({ o, items: items.filter((i) => i.orderId === o.id) }));
    });
    if (rows.length === 0) return { pedidos: [], instruccion: "El cliente no tiene pedidos en las últimas 24 horas. Dilo y ofrece tomar uno." };
    return {
      pedidos: rows.map(({ o, items }) => ({
        pedido_numero: o.number,
        estado: statusText(o),
        total: money(o.totalCents),
        modo: o.mode === "delivery" ? "a domicilio" : "para recoger",
        ...(o.mode === "delivery" && o.deliveryAddress ? { direccion: `${o.deliveryAddress}${o.deliveryZoneName ? `, col. ${o.deliveryZoneName}` : ""}` } : {}),
        articulos: items.map((i) => `${i.quantity} × ${i.name}`),
        ...((o.status === "new" || o.status === "preparing" || (o.status === "ready" && o.mode === "delivery")) && o.estimatedReadyAt ? { llegada_aproximada: formatLocal(o.estimatedReadyAt, ctx.tenant.timezone) } : {}),
        ...(o.status === "cancelled" && o.cancelReason ? { motivo_de_cancelacion: o.cancelReason } : {}),
      })),
      instruccion: "Responde con el estado real. Si es para recoger y ya está listo, dile que puede pasar; si es a domicilio, que va en camino o está por salir.",
    };
  },
});

const cancelarPedido = defineModuleTool({
  name: "cancelar_pedido",
  description:
    "Cancela un pedido del cliente, SOLO si todavía no empieza a prepararse. Primero llámala SIN confirmado para el resumen; solo cuando el cliente confirme, vuelve a llamarla con confirmado=true.",
  mutating: true,
  schema: z.object({ pedido_numero: z.number().int().positive().describe("El número de pedido que le diste al cliente"), confirmado }),
  async execute(args, ctx) {
    const order = await withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => {
      const [row] = await tx.select().from(orders).where(and(eq(orders.number, args.pedido_numero), eq(orders.contactId, ctx.contactId)));
      return row ?? null;
    });
    if (!order) return { error: "pedido_no_encontrado", instruccion: "No hay un pedido con ese número a nombre de este cliente. Revisa con estado_pedido." };
    if (order.status === "cancelled" || order.status === "delivered") return { error: "pedido_cerrado", estado: statusText(order), instruccion: `El pedido #${order.number} ya está ${statusText(order)}: no se puede cancelar.` };
    if (order.status !== "new") {
      return { error: "ya_en_preparacion", estado: statusText(order), instruccion: `El pedido #${order.number} ya está ${statusText(order)}: no se puede cancelar por aquí. Díselo con amabilidad y usa escalar_a_humano para que una persona lo vea.` };
    }

    const summary = `Cancelar el pedido #${order.number} (${money(order.totalCents)}).`;
    const gate = confirmationGate(ctx, "cancelar_pedido", { pedido_numero: args.pedido_numero }, args.confirmado, summary);
    if (gate) return gate;
    if (ctx.mode === "dry") return proposeAction(ctx, { tool: "cancelar_pedido", args: { pedido_numero: args.pedido_numero }, summary });

    const done = await withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => {
      // Solo si sigue "nuevo": el equipo pudo empezarlo justo antes.
      const rows = await tx
        .update(orders)
        .set({ status: "cancelled", cancelledAt: ctx.now, cancelledBy: "cliente", cancelReason: "Lo canceló el cliente", updatedAt: ctx.now })
        .where(and(eq(orders.id, order.id), eq(orders.status, "new")))
        .returning({ id: orders.id });
      if (rows.length === 0) return false;
      await orderAudit(tx, ctx, "order.cancelled", order.id, { number: order.number, by: "cliente" });
      return true;
    });
    if (!done) return { error: "ya_en_preparacion", instruccion: `El pedido #${order.number} acaba de empezar a prepararse: no se puede cancelar. Díselo y usa escalar_a_humano para que una persona lo vea.` };
    finishMutation(ctx);
    return { ok: true, pedido_numero: order.number, confirmacion: `El pedido #${order.number} quedó cancelado.` };
  },
});

// ------------------------------------------------------------------------------------------- registro

registerModuleTools("restaurante", [
  defineModuleTool({
    name: "consultar_menu",
    description:
      "Consulta el menú real del restaurante: platillos, precios, ingredientes y modificadores (tamaños, extras, etc.), y las condiciones de pedido (formas de pago, tiempo, mínimo). Úsala para CUALQUIER pregunta de platillos o precios y para obtener los platillo_id y opcion_id al tomar un pedido. Sin 'busqueda' devuelve un resumen por categorías; con una palabra (un platillo, un ingrediente o una categoría) devuelve el detalle.",
    mutating: false,
    schema: z.object({
      busqueda: z.string().trim().max(120).optional().describe("Platillo, ingrediente o categoría, por ejemplo 'pastor', 'hawaiana', 'bebidas'. Vacío = resumen del menú."),
    }),
    async execute(args, ctx) {
      const { menu, settings, zones } = await withTenant(ctx.db, { tenantId: ctx.tenantId }, async (tx) => ({ menu: await loadMenu(tx), settings: await loadRestaurantSettings(tx), zones: await loadDeliveryZones(tx) }));
      return consultMenu(menu, args.busqueda, settings, zones);
    },
  }),
  crearPedido,
  estadoPedido,
  cancelarPedido,
]);

registerModulePrompt("restaurante", {
  tasks: [
    "- Responder dudas del menú (platillos, precios, ingredientes y modificadores) usando consultar_menu.",
    "- Tomar pedidos para recoger en el local o a domicilio (si el restaurante lo ofrece), consultar su estado y cancelarlos mientras no se preparen.",
  ],
  truthRules: [
    "Platillos, precios, ingredientes y modificadores salen SOLO de consultar_menu. Si un platillo no aparece, no existe: no lo ofrezcas ni inventes alternativas. Si está agotado, dilo y ofrece otra cosa del menú.",
    "Nunca inventes ingredientes ni alérgenos. Si preguntan por alergias, intolerancias o dietas y el menú no lo dice, escala a una persona antes de recomendar algo.",
    `Un pedido solo existe si crear_pedido lo confirmó con su número de pedido. Nunca digas "ya quedó tu pedido" sin ese resultado. Los totales los da el sistema: nunca los calcules tú.`,
  ],
  flow: `CONSULTAR EL MENÚ:
1. Para cualquier precio o platillo usa consultar_menu con lo que pide el cliente (una palabra basta). No respondas de memoria.
2. Si piden "el menú" o una categoría, resume las categorías y ofrece dar el detalle; no pegues listas enormes.
3. Di los precios en pesos y menciona los modificadores obligatorios (por ejemplo el tamaño) con su costo extra.

TOMAR UN PEDIDO (para recoger en el local o, solo si info_de_pedidos.a_domicilio lo ofrece, a domicilio; si lo piden a domicilio y no hay, díselo y ofrece recoger):
1. Busca cada platillo con consultar_menu para obtener su platillo_id y los opcion_id. Si falta un modificador obligatorio (por ejemplo el tamaño), pregúntalo.
2. Anota con las palabras del cliente lo especial de cada platillo ("sin cebolla") en las notas de ESE platillo.
3. Pide lo que falte: el nombre (guárdalo con guardar_datos_contacto), si recoge o es a domicilio, y cómo va a pagar, entre las formas_de_pago del negocio.
   A DOMICILIO: pide calle y número con referencias, y la colonia. Las zonas y el costo de envío salen de info_de_pedidos.a_domicilio: si su colonia no está, díselo con las zonas que sí cubren y ofrece recoger. El envío lo calcula el sistema; no lo inventes ni lo sumes tú.
4. ANTES de crear: llama crear_pedido SIN confirmado para obtener el resumen con el total, repítelo completo al cliente y pide confirmación explícita. Solo cuando responda que sí, vuelve a llamarla con los mismos datos y confirmado=true.
5. Confirma usando el resultado real: dile su número de pedido, el total (con envío si es a domicilio) y en cuánto tiempo estará listo o llegará. Si paga por transferencia, dale los datos.
6. Si pregunta "¿ya está mi pedido?", usa estado_pedido. Para cancelar, cancelar_pedido (solo si aún no se prepara; si ya empezó, díselo y pásalo con una persona).
7. Si el sistema dice que están cerrados o que no toman pedidos por ahora, díselo con amabilidad y no insistas.`,
  escalation: "ALERGIAS Y DIETAS: una alergia o intolerancia siempre se escala a una persona antes de recomendar un platillo.",
});
