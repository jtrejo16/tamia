import { channels, contacts, conversations, withTenant, type Database } from "@empleado/db";
import { and, asc, desc, eq, ne } from "drizzle-orm";

export interface EnsureConversationInput {
  tenantId: string;
  /** Telefono del cliente en formato E.164, por ejemplo +529991234567. */
  phone: string;
  name?: string;
  channelType?: string;
}

export interface ConversationRef {
  conversationId: string;
  contactId: string;
  channelId: string;
}

/**
 * Busca (o crea) el contacto y su conversacion abierta en el primer canal activo del negocio.
 * Lo usan el probador y, mas adelante, el webhook de WhatsApp.
 */
export async function ensureConversation(
  db: Database,
  input: EnsureConversationInput,
): Promise<ConversationRef> {
  return withTenant(db, { tenantId: input.tenantId }, async (tx) => {
    const [channel] = await tx
      .select()
      .from(channels)
      .where(and(eq(channels.type, input.channelType ?? "whatsapp"), eq(channels.status, "active")))
      .orderBy(asc(channels.createdAt))
      .limit(1);
    if (!channel) throw new Error("El negocio no tiene un canal activo conectado");

    let [contact] = await tx.select().from(contacts).where(eq(contacts.phoneE164, input.phone));
    if (!contact) {
      [contact] = await tx
        .insert(contacts)
        .values({ tenantId: input.tenantId, phoneE164: input.phone, displayName: input.name ?? null })
        .returning();
    }

    const [open] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.contactId, contact!.id), ne(conversations.state, "closed")))
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    if (open) {
      return { conversationId: open.id, contactId: contact!.id, channelId: open.channelId };
    }

    const [created] = await tx
      .insert(conversations)
      .values({ tenantId: input.tenantId, contactId: contact!.id, channelId: channel.id })
      .returning();
    return { conversationId: created!.id, contactId: contact!.id, channelId: channel.id };
  });
}
