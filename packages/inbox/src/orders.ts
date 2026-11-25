import {
  auditLog,
  channels,
  conversations,
  loadRestaurantSettings,
  messages,
  orderItemModifiers,
  orderItems,
  orders,
  restaurantSettings,
  tenants,
  PAYMENT_METHODS,
  withTenant,
  type Database,
  type OrderStatus,
  type RestaurantSettingsRow,
  type Tx,
} from "@empleado/db";
import { isWithinServiceWindow } from "@empleado/channels";
import { hasModule, modulesFor } from "@empleado/shared";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { can, fail, type EnqueueOutbound, type Failure, type PanelContext, type Success } from "./types";

/**
 * Pedidos del restaurante (modulo "restaurante"): el tablero del equipo. Ver lo puede todo rol; cambiar estados, el dueno y
 * la recepcion. Cuando un pedido pasa a "listo" o se cancela, se le escribe al cliente por el mismo canal (si la ventana de
 * 24 h de WhatsApp sigue abierta; si no, el cambio se guarda igual y se avisa que no se pudo notificar).
 */

export type OrderError = "forbidden" | "module_off" | "not_found" | "invalid_transition" | "invalid";

const scope = (ctx: PanelContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

async function gate(tx: Tx, ctx: PanelContext, write: boolean): Promise<Failure<"forbidden" | "module_off"> | null> {
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
    if (await gate(tx, ctx, false)) return fail("module_off" as const);
    const rows =
      which === "active"
        ? await tx.select().from(orders).where(inArray(orders.status, ["new", "preparing", "ready"])).orderBy(asc(orders.createdAt)).limit(200)
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

/** Transiciones permitidas. Se puede saltar "preparando" (pedido rapido), pero no volver atras. */
const NEXT: Record<OrderStatus, OrderStatus[]> = {
  new: ["preparing", "ready", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

export type NoticeResult = "sent" | "window_closed" | "no_conversation" | "voice" | "not_needed";

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
    const denied = await gate(tx, ctx, true);
    if (denied) return denied;
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
    if (!order) return fail("not_found" as const);
    if (!NEXT[order.status].includes(to)) return fail("invalid_transition" as const);

    // Solo si sigue en el estado que vimos: dos personas pueden tocar el mismo pedido a la vez.
    const patch: Partial<typeof orders.$inferInsert> = { status: to, updatedAt: now };
    if (to === "preparing") patch.preparingAt = now;
    if (to === "ready") {
      patch.readyAt = now;
      if (!order.preparingAt) patch.preparingAt = now;
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

    // Aviso al cliente: solo al quedar listo o al cancelar.
    let notice: NoticeResult = "not_needed";
    let messageId: string | null = null;
    if (to === "ready" || to === "cancelled") {
      const text =
        to === "ready"
          ? `¡Tu pedido #${order.number} ya está listo para recoger! Total: ${money(order.totalCents)}.`
          : `Tu pedido #${order.number} fue cancelado por el restaurante${reason ? `: ${reason}` : ""}. Disculpa las molestias; si quieres, escríbenos y lo resolvemos.`;
      if (!order.conversationId) notice = "no_conversation";
      else {
        const [conv] = await tx.select().from(conversations).where(eq(conversations.id, order.conversationId));
        const [channel] = conv ? await tx.select({ type: channels.type }).from(channels).where(eq(channels.id, conv.channelId)) : [];
        if (!conv) notice = "no_conversation";
        else if (channel?.type === "voice") notice = "voice";
        else if (!isWithinServiceWindow(conv.lastInboundAt, now)) notice = "window_closed";
        else {
          const [msg] = await tx
            .insert(messages)
            .values({ tenantId: ctx.tenantId, conversationId: conv.id, channelId: conv.channelId, direction: "out", sender: "human", type: "text", body: text, status: "queued" })
            .returning({ id: messages.id });
          await tx.update(conversations).set({ lastMessageAt: now, updatedAt: now }).where(eq(conversations.id, conv.id));
          messageId = msg!.id;
          notice = "sent";
        }
      }
    }
    return { ok: true as const, status: to, notice, messageId };
  });
  if (!outcome.ok) return outcome;
  if (outcome.messageId) await enqueue({ tenantId: ctx.tenantId, messageId: outcome.messageId }).catch(() => {});
  return { ok: true, status: outcome.status, notice: outcome.notice };
}

// -------------------------------------------------------------------------------------- ajustes

export type SettingsFail = Failure<"forbidden" | "module_off"> | (Failure<"invalid"> & { details: string[] });

export async function getRestaurantSettings(db: Database, ctx: PanelContext): Promise<Success<{ settings: RestaurantSettingsRow }> | Failure<"module_off">> {
  return withTenant(db, scope(ctx), async (tx) => {
    if (await gate(tx, ctx, false)) return fail("module_off" as const);
    return { ok: true as const, settings: await loadRestaurantSettings(tx) };
  });
}

export async function saveRestaurantSettings(db: Database, ctx: PanelContext, input: Record<string, unknown>): Promise<Success<{ settings: RestaurantSettingsRow }> | SettingsFail> {
  const errors: string[] = [];
  const prep = Number(input.prepMinutes);
  if (!Number.isInteger(prep) || prep < 5 || prep > 240) errors.push("El tiempo de preparación debe ser de 5 a 240 minutos.");
  const minPesos = Number(input.minOrderPesos ?? 0);
  if (!Number.isFinite(minPesos) || minPesos < 0 || minPesos > 100_000) errors.push("El pedido mínimo no es válido.");
  const methods = Array.isArray(input.paymentMethods) ? [...new Set(input.paymentMethods.filter((m): m is string => typeof m === "string"))] : [];
  if (methods.length === 0 || methods.some((m) => !(PAYMENT_METHODS as readonly string[]).includes(m))) errors.push("Elige al menos una forma de pago válida.");
  const transferInfo = typeof input.transferInfo === "string" ? input.transferInfo.trim().slice(0, 300) : "";
  if (methods.includes("transferencia") && !transferInfo) errors.push("Para aceptar transferencias escribe los datos (CLABE y titular).");
  if (errors.length > 0) return { ok: false, error: "invalid", details: errors };

  return withTenant(db, scope(ctx), async (tx) => {
    const denied = await gate(tx, ctx, true);
    if (denied) return denied;
    const values = {
      acceptingOrders: input.acceptingOrders !== false,
      prepMinutes: prep,
      minOrderCents: Math.round(minPesos * 100),
      paymentMethods: methods,
      transferInfo: methods.includes("transferencia") ? transferInfo : null,
      updatedAt: new Date(),
    };
    await tx
      .insert(restaurantSettings)
      .values({ tenantId: ctx.tenantId, ...values })
      .onConflictDoUpdate({ target: restaurantSettings.tenantId, set: values });
    await tx.insert(auditLog).values({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "order.settings",
      entity: "restaurant_settings",
      entityId: ctx.tenantId,
      diff: { acceptingOrders: values.acceptingOrders, prepMinutes: prep, minOrderCents: values.minOrderCents, paymentMethods: methods },
    });
    return { ok: true as const, settings: await loadRestaurantSettings(tx) };
  });
}
