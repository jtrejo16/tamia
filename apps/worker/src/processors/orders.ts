import {
  auditLog,
  notificationSettings,
  orderItemModifiers,
  orderItems,
  orders,
  ordersToNotify,
  tenants,
  withTenant,
  type Database,
} from "@empleado/db";
import { sendEmail, type EmailDeps } from "@empleado/inbox";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Logger } from "../config";

/**
 * Avisa al EQUIPO (por correo) cuando entra un pedido nuevo. Es el mismo canal de avisos del negocio (los destinatarios de
 * correo de "Avisos al equipo"); el panel ademas muestra el pedido al instante en el tablero. Cada minuto el worker revisa los
 * pedidos pendientes de aviso. Se "reclama" el pedido ANTES de enviar para no duplicar con mas de un worker.
 */

export interface OrderNotifyDeps {
  db: Database;
  /** Correo: null = sin servicio configurado (no se avisa; el tablero sigue funcionando). */
  email: EmailDeps | null;
  sendEmail?: typeof sendEmail;
  baseUrl: string | null;
  now?: () => Date;
  log?: Logger;
}

export type OrderNotifyResult = { status: "sent"; email: number } | { status: "skipped"; reason: "not_found" | "already" | "no_email" } | { status: "failed" };

const CHANNEL_LABEL: Record<string, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram", voice: "llamada", panel: "el panel" };
const PAYMENT_LABEL: Record<string, string> = { efectivo: "efectivo", tarjeta: "tarjeta", transferencia: "transferencia" };

const money = (cents: number) => `$${(cents / 100).toLocaleString("es-MX", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })} MXN`;

export function createOrderNotifier(deps: OrderNotifyDeps) {
  const log = deps.log ?? (() => {});
  const send = deps.sendEmail ?? sendEmail;

  return async (job: { tenantId: string; orderId: string }): Promise<OrderNotifyResult> => {
    const { tenantId, orderId } = job;
    const loaded = await withTenant(deps.db, { tenantId }, async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
      if (!order) return null;
      const [settings] = await tx.select().from(notificationSettings);
      const [tenant] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
      const lines = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.sortOrder));
      const mods = lines.length ? await tx.select().from(orderItemModifiers).where(inArray(orderItemModifiers.orderItemId, lines.map((l) => l.id))) : [];
      return { order, settings, tenantName: tenant?.name ?? "tu restaurante", lines, mods };
    });
    if (!loaded || !loaded.settings?.enabled) return { status: "skipped", reason: "not_found" };
    const { order, settings, lines, mods } = loaded;
    if (order.notifiedAt) return { status: "skipped", reason: "already" };

    const recipients = settings.recipients.filter((r) => r.enabled && r.kind === "email");
    if (recipients.length === 0 || !deps.email) {
      log("orders.notify_not_ready", { tenantId, orderId, hint: "Falta un destinatario de correo en Avisos al equipo o el servicio de correo" });
      return { status: "skipped", reason: "no_email" };
    }

    const claimed = await withTenant(deps.db, { tenantId }, (tx) =>
      tx.update(orders).set({ notifiedAt: deps.now?.() ?? new Date() }).where(and(eq(orders.id, orderId), isNull(orders.notifiedAt))).returning({ id: orders.id }),
    );
    if (claimed.length === 0) return { status: "skipped", reason: "already" };

    const detail = lines
      .map((l) => {
        const m = mods.filter((x) => x.orderItemId === l.id).map((x) => `${x.groupName}: ${x.optionName}`);
        return `  • ${l.quantity} × ${l.name}${m.length ? ` (${m.join("; ")})` : ""}${l.notes ? ` — ${l.notes}` : ""}`;
      })
      .join("\n");
    const url = `${(deps.baseUrl ?? "https://www.jovia.mx").replace(/\/$/, "")}/pedidos`;
    const text =
      `Nuevo pedido #${order.number} por ${CHANNEL_LABEL[order.channel] ?? order.channel} en ${loaded.tenantName}.\n\n` +
      `Cliente: ${order.customerName}${order.customerPhone ? ` (${order.customerPhone})` : ""}\n` +
      `Para recoger en el local · pago en ${PAYMENT_LABEL[order.paymentMethod] ?? order.paymentMethod}\n\n${detail}\n\n` +
      `Total: ${money(order.totalCents)}${order.notes ? `\nNota: ${order.notes}` : ""}\n\nAbre el tablero: ${url}\n\n— Jovia`;

    let sent = 0;
    for (const r of recipients) {
      try {
        await send(deps.email, { to: r.address, subject: `Pedido #${order.number} · ${order.customerName} · ${money(order.totalCents)}`, text });
        sent++;
      } catch (error) {
        log("orders.notify_recipient_failed", { tenantId, orderId, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (sent === 0) {
      // Nada salio: se libera para reintentar (hasta 5 veces).
      await withTenant(deps.db, { tenantId }, (tx) => tx.update(orders).set({ notifiedAt: null, notifyAttempts: sql`${orders.notifyAttempts} + 1` }).where(eq(orders.id, orderId)));
      return { status: "failed" };
    }
    await withTenant(deps.db, { tenantId }, (tx) =>
      tx.insert(auditLog).values({ tenantId, action: "order.notified", entity: "order", entityId: orderId, diff: { number: order.number, email: sent } as never }),
    );
    log("orders.notified", { tenantId, orderId, email: sent });
    return { status: "sent", email: sent };
  };
}

/** Revisa que pedidos nuevos faltan por avisar. Lo llama el worker cada minuto. */
export function createOrderScanner(deps: OrderNotifyDeps) {
  const notify = createOrderNotifier(deps);
  return async (): Promise<{ sent: number; skipped: number; errors: number }> => {
    const due = await ordersToNotify(deps.db, 50);
    let sent = 0;
    let skipped = 0;
    let errors = 0;
    for (const job of due) {
      try {
        const r = await notify(job);
        if (r.status === "sent") sent++;
        else if (r.status === "failed") errors++;
        else skipped++;
      } catch (error) {
        errors++;
        deps.log?.("orders.scan_error", { ...job, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { sent, skipped, errors };
  };
}
