import { channels, conversations, messages, type Tx } from "@empleado/db";
import { isWithinServiceWindow } from "@empleado/channels";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";

/**
 * Aviso del equipo al cliente (un pedido listo, una reservacion cancelada...). Va por la conversacion donde el cliente nos
 * escribio, solo si la ventana de 24 h de WhatsApp sigue abierta. Una llamada no se contesta por texto: si el cliente tambien
 * nos escribe por otro canal y su ventana esta abierta, el aviso va por ahi. Si no hay por donde, el cambio se guarda igual y el
 * panel avisa que no se pudo notificar.
 */

export type NoticeResult = "sent" | "window_closed" | "no_conversation" | "voice" | "not_needed";

/** Deja el mensaje en cola dentro de la transaccion; quien llama debe encolar su envio despues (si `messageId` no es null). */
export async function sendCustomerNotice(
  tx: Tx,
  input: { tenantId: string; contactId: string; conversationId: string | null; text: string; now: Date },
): Promise<{ notice: NoticeResult; messageId: string | null }> {
  const { tenantId, contactId, conversationId, text, now } = input;
  if (!conversationId) return { notice: "no_conversation", messageId: null };
  const [conv] = await tx.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!conv) return { notice: "no_conversation", messageId: null };
  const [channel] = await tx.select({ type: channels.type }).from(channels).where(eq(channels.id, conv.channelId));

  let target: { id: string; channelId: string } | null = null;
  let blocked: NoticeResult = "window_closed";
  if (channel?.type === "voice") {
    const [alt] = await tx
      .select({ id: conversations.id, channelId: conversations.channelId, lastInboundAt: conversations.lastInboundAt })
      .from(conversations)
      .innerJoin(channels, eq(channels.id, conversations.channelId))
      .where(and(eq(conversations.contactId, contactId), ne(channels.type, "voice"), isNotNull(conversations.lastInboundAt)))
      .orderBy(desc(conversations.lastInboundAt))
      .limit(1);
    if (alt && isWithinServiceWindow(alt.lastInboundAt, now)) target = alt;
    else blocked = "voice";
  } else if (isWithinServiceWindow(conv.lastInboundAt, now)) target = { id: conv.id, channelId: conv.channelId };

  if (!target) return { notice: blocked, messageId: null };
  const [msg] = await tx
    .insert(messages)
    .values({ tenantId, conversationId: target.id, channelId: target.channelId, direction: "out", sender: "human", type: "text", body: text, status: "queued" })
    .returning({ id: messages.id });
  await tx.update(conversations).set({ lastMessageAt: now, updatedAt: now }).where(eq(conversations.id, target.id));
  return { notice: "sent", messageId: msg!.id };
}
