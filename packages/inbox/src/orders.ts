import {
  auditLog,
  deliveryZones,
  loadDeliveryZones,
  loadRestaurantSettings,
  orderItemModifiers,
  orderItems,
  orders,
  restaurantSettings,
  tenants,
  PAYMENT_METHODS,
  withTenant,
  type Database,
  type DeliveryZoneRow,
  type OrderStatus,
  type RestaurantSettingsRow,
  type Tx,
} from "@empleado/db";
import { hasModule, modulesFor } from "@empleado/shared";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { sendCustomerNotice, type NoticeResult } from "./notices";
import { can, fail, type EnqueueOutbound, type Failure, type PanelContext, type Success } from "./types";

/**
 * Pedidos del restaurante (modulo "restaurante"): el tablero del equipo. Ver lo puede todo rol; cambiar estados, el dueno y
 * la recepcion. Cuando un pedido pasa a "listo" o se cancela, se le escribe al cliente por el mismo canal (si la ventana de
 * 24 h de WhatsApp sigue abierta; si no, el cambio se guarda igual y se avisa que no se pudo notificar).
 */

export type OrderError = "forbidden" | "module_off" | "not_found" | "invalid_transition" | "invalid";

const scope = (ctx: PanelContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

export async function restaurantGate(tx: Tx, ctx: PanelContext, write: boolean): Promise<Failure<"forbidden" | "module_off"> | null> {
  if (write && !can(ctx.role, "manage_appointments")) return fail("forbidden");
  const [t] = await tx.select({ vertical: tenants.vertical, profile: tenants.profile }).from(tenants).where(eq(tenants.id, ctx.tenantId));
  if (!t || !hasModule(modulesFor(t.vertical, t.profile?.modules), "restaurante")) return fail("module_off");
  return null;
}

// ------------------------------------------------------------------------------------------- leer

export interface OrderLineView {
  id: string;
  name: string;
  quantity: number;
  notes: string | null;
  lineTotalCents: number;
  modifiers: Array<{ groupName: string; optionName: string; priceDeltaCents: number }>;
}

export interface OrderView {
  id: string;
  number: number;
  status: OrderStatus;
  channel: string;
  mode: "pickup" | "delivery";
  deliveryAddress: string | null;
  deliveryZoneName: string | null;
  deliveryFeeCents: number;
  conversationId: string | null;
  customerName: string;
  customerPhone: string | null;
  notes: string | null;
  paymentMethod: string;
  totalCents: number;
  createdAt: string;
  estimatedReadyAt: string | null;
  readyAt: string | null;
  cancelReason: string | null;
  cancelledBy: string | null;
  lines: OrderLineView[];
}

export type OrderScope = "active" | "history";

const HISTORY_DAYS = 7;
const HISTORY_LIMIT = 100;

/** "active": nuevos, en preparacion y listos (lo que la cocina tiene en curso). "history": entregados y cancelados de la ultima semana. */
export async function listOrders(db: Database, ctx: PanelContext, which: OrderScope, now: Date = new Date()): Promise<Success<{ orders: OrderView[] }> | Failure<"module_off">> {
  return withTenant(db, scope(ctx), async (tx) => {
    if (await restaurantGate(tx, ctx, false)) return fail("module_off" as const);
    const rows =
      which === "active"
        ? await tx.select().from(orders).where(inArray(orders.status, ["new", "preparing", "ready", "on_the_way"])).orderBy(asc(orders.createdAt)).limit(200)
        : await tx
            .select()
            .from(orders)
            .where(and(inArray(orders.status, ["delivered", "cancelled"]), gte(orders.createdAt, new Date(now.getTime() - HISTORY_DAYS * 86_400_000))))
            .orderBy(desc(orders.createdAt))
            .limit(HISTORY_LIMIT);
    const ids = rows.map((o) => o.id);
    const items = ids.length ? await tx.select().from(orderItems).where(inArray(orderItems.orderId, ids)).orderBy(asc(orderItems.sortOrder)) : [];
    const mods = items.length ? await tx.select().from(orderItemModifiers).where(inArray(orderItemModifiers.orderItemId, items.map((i) => i.id))) : [];
    return {
      ok: true as const,
      orders: rows.map((o) => ({
        id: o.id,
        number: o.number,
        status: o.status,
        channel: o.channel,
        mode: o.mode,
        deliveryAddress: o.deliveryAddress,
        deliveryZoneName: o.deliveryZoneName,
        deliveryFeeCents: o.deliveryFeeCents,
        conversationId: o.conversationId,
        customerName: o.customerName,
        customerPhone: o.customerPhone,
        notes: o.notes,
        paymentMethod: o.paymentMethod,
        totalCents: o.totalCents,
        createdAt: o.createdAt.toISOString(),
        estimatedReadyAt: o.estimatedReadyAt?.toISOString() ?? null,
        readyAt: o.readyAt?.toISOString() ?? null,
        cancelReason: o.cancelReason,
        cancelledBy: o.cancelledBy,
        lines: items
          .filter((i) => i.orderId === o.id)
          .map((i) => ({
            id: i.id,
            name: i.name,
            quantity: i.quantity,
            notes: i.notes,
            lineTotalCents: i.lineTotalCents,
            modifiers: mods.filter((m) => m.orderItemId === i.id).map((m) => ({ groupName: m.groupName, optionName: m.optionName, priceDeltaCents: m.priceDeltaCents })),
          })),
      })),
    };
  });
}

/** Pedidos nuevos (sin atender) para la insignia del menu. 0 si el negocio no usa el modulo. */
export async function countNewOrders(db: Database, ctx: PanelContext): Promise<number> {
  return withTenant(db, scope(ctx), async (tx) => {
    const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(orders).where(eq(orders.status, "new"));
    return Number(row?.n ?? 0);
  });
}

// --------------------------------------------------------------------------------------- estados

/**
 * Transiciones permitidas. Se puede saltar "preparando" (pedido rapido), pero no volver atras. "En camino" solo existe en los
 * pedidos a domicilio (y ahi es opcional: se puede pasar de listo a entregado).
 */
function nextStates(status: OrderStatus, mode: string): OrderStatus[] {
  switch (status) {
    case "new":
      return ["preparing", "ready", "cancelled"];
    case "preparing":
      return ["ready", "cancelled"];
    case "ready":
      return mode === "delivery" ? ["on_the_way", "delivered", "cancelled"] : ["delivered", "cancelled"];
    case "on_the_way":
      return ["delivered", "cancelled"];
    default:
      return [];
  }
}

export type SetStatusResult = {
  status: OrderStatus;
  /** Si se le escribio al cliente del cambio. */
  notice: NoticeResult;
};

const money = (cents: number) => `$${(cents / 100).toLocaleString("es-MX", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })} MXN`;

export async function setOrderStatus(
  db: Database,
  ctx: PanelContext,
  orderId: string,
  to: OrderStatus,
  input: { reason?: string },
  enqueue: EnqueueOutbound,
  now: Date = new Date(),
): Promise<Success<SetStatusResult> | Failure<OrderError>> {
  const reason = input.reason?.trim().slice(0, 200) || null;
  const outcome = await withTenant(db, scope(ctx), async (tx) => {
    const denied = await restaurantGate(tx, ctx, true);
    if (denied) return denied;
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
    if (!order) return fail("not_found" as const);
    if (!nextStates(order.status, order.mode).includes(to)) return fail("invalid_transition" as const);

    // Solo si sigue en el estado que vimos: dos personas pueden tocar el mismo pedido a la vez.
    const patch: Partial<typeof orders.$inferInsert> = { status: to, updatedAt: now };
    if (to === "preparing") patch.preparingAt = now;
    if (to === "ready") {
      patch.readyAt = now;
      if (!order.preparingAt) patch.preparingAt = now;
    }
    if (to === "on_the_way") {
      patch.onTheWayAt = now;
      if (!order.readyAt) patch.readyAt = now;
    }
    if (to === "delivered") {
      patch.deliveredAt = now;
      if (!order.readyAt) patch.readyAt = now;
    }
    if (to === "cancelled") {
      patch.cancelledAt = now;
      patch.cancelledBy = "equipo";
      patch.cancelReason = reason ?? "Cancelado por el restaurante";
    }
    const changed = await tx.update(orders).set(patch).where(and(eq(orders.id, orderId), eq(orders.status, order.status))).returning({ id: orders.id });
    if (changed.length === 0) return fail("invalid_transition" as const);
    await tx.insert(auditLog).values({ tenantId: ctx.tenantId, userId: ctx.userId, action: "order.status", entity: "order", entityId: orderId, diff: { number: order.number, from: order.status, to } });

    // Aviso al cliente: al quedar listo para recoger, al salir a domicilio y al cancelar.
    let notice: NoticeResult = "not_needed";
    let messageId: string | null = null;
    const tells = to === "cancelled" || to === "on_the_way" || (to === "ready" && order.mode === "pickup");
    if (tells) {
      const text =
        to === "ready"
          ? `¡Tu pedido #${order.number} ya está listo para recoger! Total: ${money(order.totalCents)}.`
          : to === "on_the_way"
            ? `¡Tu pedido #${order.number} va en camino a tu domicilio! Total a pagar: ${money(order.totalCents)}.`
            : `Tu pedido #${order.number} fue cancelado por el restaurante${reason ? `: ${reason}` : ""}. Disculpa las molestias; si quieres, escríbenos y lo resolvemos.`;
      const sent = await sendCustomerNotice(tx, { tenantId: ctx.tenantId, contactId: order.contactId, conversationId: order.conversationId, text, now });
      notice = sent.notice;
      messageId = sent.messageId;
    }
    return { ok: true as const, status: to, notice, messageId };
  });
  if (!outcome.ok) return outcome;
  if (outcome.messageId) await enqueue({ tenantId: ctx.tenantId, messageId: outcome.messageId }).catch(() => {});
  return { ok: true, status: outcome.status, notice: outcome.notice };
}

// -------------------------------------------------------------------------------------- ajustes

export type SettingsFail = Failure<"forbidden" | "module_off"> | (Failure<"invalid"> & { details: string[] });
export type SettingsView = { settings: RestaurantSettingsRow; zones: DeliveryZoneRow[] };

export async function getRestaurantSettings(db: Database, ctx: PanelContext): Promise<Success<SettingsView> | Failure<"module_off">> {
  return withTenant(db, scope(ctx), async (tx) => {
    if (await restaurantGate(tx, ctx, false)) return fail("module_off" as const);
    return { ok: true as const, settings: await loadRestaurantSettings(tx), zones: await loadDeliveryZones(tx) };
  });
}

const MAX_ZONES = 60;
const normName = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pesos (numero o texto) a centavos (vacio = 0), o null si no es un monto valido. */
function pesosToCents(v: unknown, max: number): number | null {
  if (v === "" || v === null || v === undefined) return 0; // vacio = sin monto
  const n = typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return Math.round(n * 100);
}

/**
 * Guarda los ajustes de pedidos y, si vienen, las zonas de entrega (la lista completa: las que ya no vengan se borran; los
 * pedidos ya hechos conservan el nombre de su zona). Para ofrecer domicilio hace falta al menos una zona activa.
 */
export async function saveRestaurantSettings(db: Database, ctx: PanelContext, input: Record<string, unknown>): Promise<Success<SettingsView> | SettingsFail> {
  const errors: string[] = [];
  const prep = Number(input.prepMinutes);
  if (!Number.isInteger(prep) || prep < 5 || prep > 240) errors.push("El tiempo de preparación debe ser de 5 a 240 minutos.");
  const minOrder = pesosToCents(input.minOrderPesos ?? 0, 100_000);
  if (minOrder === null) errors.push("El pedido mínimo no es válido.");
  const methods = Array.isArray(input.paymentMethods) ? [...new Set(input.paymentMethods.filter((m): m is string => typeof m === "string"))] : [];
  if (methods.length === 0 || methods.some((m) => !(PAYMENT_METHODS as readonly string[]).includes(m))) errors.push("Elige al menos una forma de pago válida.");
  const transferInfo = typeof input.transferInfo === "string" ? input.transferInfo.trim().slice(0, 300) : "";
  if (methods.includes("transferencia") && !transferInfo) errors.push("Para aceptar transferencias escribe los datos (CLABE y titular).");

  const deliveryEnabled = input.deliveryEnabled === true;
  const deliveryMinutes = Number(input.deliveryMinutes ?? 40);
  if (!Number.isInteger(deliveryMinutes) || deliveryMinutes < 10 || deliveryMinutes > 240) errors.push("El tiempo de entrega debe ser de 10 a 240 minutos.");
  const freeRaw = input.freeDeliveryFromPesos;
  const freeFrom = freeRaw === undefined || freeRaw === null || freeRaw === "" || Number(freeRaw) === 0 ? null : pesosToCents(freeRaw, 100_000);
  if (freeRaw !== undefined && freeRaw !== null && freeRaw !== "" && Number(freeRaw) !== 0 && freeFrom === null) errors.push("El monto de envío gratis no es válido.");

  type ZoneInput = { id: string | null; name: string; feeCents: number; minOrderCents: number; active: boolean };
  let zonesIn: ZoneInput[] | null = null;
  if (input.zones !== undefined) {
    const raw = Array.isArray(input.zones) ? input.zones : [];
    if (raw.length > MAX_ZONES) errors.push(`Máximo ${MAX_ZONES} zonas.`);
    const seen = new Set<string>();
    zonesIn = [];
    for (const [n, z] of raw.slice(0, MAX_ZONES).entries()) {
      const r = (z ?? {}) as Record<string, unknown>;
      const name = typeof r.name === "string" ? r.name.trim() : "";
      const fee = pesosToCents(r.feePesos ?? 0, 5_000);
      const zmin = pesosToCents(r.minOrderPesos ?? 0, 100_000);
      if (!name || name.length > 80) errors.push(`La zona ${n + 1} necesita un nombre (máximo 80 caracteres).`);
      else if (seen.has(normName(name))) errors.push(`La zona «${name}» está repetida.`);
      if (fee === null) errors.push(`El costo de envío de «${name || n + 1}» no es válido (0 a $5,000).`);
      if (zmin === null) errors.push(`El pedido mínimo de «${name || n + 1}» no es válido.`);
      seen.add(normName(name));
      zonesIn.push({ id: typeof r.id === "string" && UUID.test(r.id) ? r.id : null, name, feeCents: fee ?? 0, minOrderCents: zmin ?? 0, active: r.active !== false });
    }
  }
  if (errors.length > 0) return { ok: false, error: "invalid", details: errors };

  return withTenant(db, scope(ctx), async (tx) => {
    const denied = await restaurantGate(tx, ctx, true);
    if (denied) return denied;
    const effectiveZones = zonesIn ?? (await loadDeliveryZones(tx));
    if (deliveryEnabled && !effectiveZones.some((z) => z.active)) return { ok: false as const, error: "invalid" as const, details: ["Para ofrecer entrega a domicilio agrega al menos una zona activa."] };

    const values = {
      acceptingOrders: input.acceptingOrders !== false,
      prepMinutes: prep,
      minOrderCents: minOrder!,
      paymentMethods: methods,
      transferInfo: methods.includes("transferencia") ? transferInfo : null,
      deliveryEnabled,
      deliveryMinutes,
      freeDeliveryFromCents: freeFrom,
      updatedAt: new Date(),
    };
    await tx.insert(restaurantSettings).values({ tenantId: ctx.tenantId, ...values }).onConflictDoUpdate({ target: restaurantSettings.tenantId, set: values });

    if (zonesIn) {
      const existing = await tx.select({ id: deliveryZones.id }).from(deliveryZones);
      const known = new Set(existing.map((z) => z.id));
      const keep = new Set(zonesIn.flatMap((z) => (z.id && known.has(z.id) ? [z.id] : [])));
      const drop = existing.filter((z) => !keep.has(z.id)).map((z) => z.id);
      // Las que se borran salen primero; las que se quedan toman un nombre temporal para poder intercambiar nombres sin chocar con el indice unico.
      if (drop.length > 0) await tx.delete(deliveryZones).where(inArray(deliveryZones.id, drop));
      for (const z of zonesIn) {
        if (z.id && known.has(z.id)) await tx.update(deliveryZones).set({ name: `~${z.id}` }).where(eq(deliveryZones.id, z.id));
      }
      for (const [i, z] of zonesIn.entries()) {
        const row = { name: z.name, feeCents: z.feeCents, minOrderCents: z.minOrderCents, active: z.active, sortOrder: i, updatedAt: new Date() };
        if (z.id && known.has(z.id)) await tx.update(deliveryZones).set(row).where(eq(deliveryZones.id, z.id));
        else await tx.insert(deliveryZones).values({ tenantId: ctx.tenantId, ...row });
      }
    }
    await tx.insert(auditLog).values({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "order.settings",
      entity: "restaurant_settings",
      entityId: ctx.tenantId,
      diff: { acceptingOrders: values.acceptingOrders, prepMinutes: prep, minOrderCents: values.minOrderCents, paymentMethods: methods, deliveryEnabled, zones: zonesIn?.length ?? undefined },
    });
    return { ok: true as const, settings: await loadRestaurantSettings(tx), zones: await loadDeliveryZones(tx) };
  });
}
