import type { StatusJobData } from "@empleado/channels";
import { messages, withTenant, type Database } from "@empleado/db";
import { and, eq } from "drizzle-orm";
import type { Logger } from "../config";

export interface StatusDeps {
  db: Database;
  log?: Logger;
}

export class MessageNotFoundYet extends Error {
  constructor(wamid: string) {
    super(`Aun no existe el mensaje ${wamid}; se reintentara`);
    this.name = "MessageNotFoundYet";
  }
}

// El estado solo avanza: un "delivered" tardio nunca pisa un "read".
const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };

export type StatusResult = { status: "updated" | "unchanged"; to?: string };

export function createStatusProcessor(deps: StatusDeps) {
  return async (job: StatusJobData): Promise<StatusResult> => {
    const { tenantId, channelId, status } = job;

    return withTenant(deps.db, { tenantId }, async (tx) => {
      const [message] = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.channelId, channelId), eq(messages.externalId, status.id)));

      // Meta puede avisar "delivered" antes de que guardemos el wamid del envio: se reintenta.
      if (!message) throw new MessageNotFoundYet(status.id);

      if (status.status === "failed") {
        if (message.status === "read") return { status: "unchanged" as const };
        const detail = [status.errorCode, status.errorTitle ?? status.errorMessage].filter(Boolean).join(": ");
        await tx
          .update(messages)
          .set({ status: "failed", error: (detail || "fallo_reportado_por_whatsapp").slice(0, 300), updatedAt: new Date() })
          .where(eq(messages.id, message.id));
        deps.log?.("status.failed", { tenantId, messageId: message.id, code: status.errorCode });
        return { status: "updated" as const, to: "failed" };
      }

      // Lo que cobra Meta por este mensaje (para los costos): se guarda aunque el estado ya no avance.
      const billing = status.pricing ? { pricingCategory: status.pricing.category.slice(0, 40), billable: status.pricing.billable } : {};
      if ((RANK[status.status] ?? 0) <= (RANK[message.status] ?? 0)) {
        if (status.pricing && (message.pricingCategory !== billing.pricingCategory || message.billable !== billing.billable)) {
          await tx.update(messages).set(billing).where(eq(messages.id, message.id));
        }
        return { status: "unchanged" as const };
      }
      await tx
        .update(messages)
        .set({ status: status.status, error: null, ...billing, updatedAt: new Date() })
        .where(eq(messages.id, message.id));
      return { status: "updated" as const, to: status.status };
    });
  };
}
