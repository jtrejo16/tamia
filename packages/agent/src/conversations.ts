import { channels, contacts, conversations, withTenant, type Database } from "@empleado/db";
import { and, asc, desc, eq, ne } from "drizzle-orm";

export interface EnsureConversationInput {
  tenantId: string;
  /** Telefono del cliente en formato E.164, por ejemplo +529991234567. */
  phone: string;
  /** Nombre confirmado del cliente (el agente lo pide y lo guarda aparte). */
  name?: string;
  /** Nombre del perfil de WhatsApp (apodo): se guarda en el perfil, no como nombre real. */
  profileName?: string;
  /** Canal exacto por el que escribio. Sin esto se usa el primer canal activo. */
  channelId?: string;
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
      .where(
        input.channelId
          ? eq(channels.id, input.channelId)
          : and(eq(channels.type, input.channelType ?? "whatsapp"), eq(channels.status, "active")),
      )
      .orderBy(asc(channels.createdAt))
      .limit(1);
    if (!channel) throw new Error("El negocio no tiene un canal activo conectado");

    let [contact] = await tx.select().from(contacts).where(eq(contacts.phoneE164, input.phone));
    if (!contact) {
      // Carrera: dos mensajes del mismo cliente nuevo a la vez. El indice unico decide.
      await tx
        .insert(contacts)
        .values({
          tenantId: input.tenantId,
          phoneE164: input.phone,
          displayName: input.name ?? null,
          profile: input.profileName ? { whatsapp_name: input.profileName } : {},
        })
        .onConflictDoNothing();
      [contact] = await tx.select().from(contacts).where(eq(contacts.phoneE164, input.phone));
    } else if (input.profileName && !(contact.profile as Record<string, unknown>)?.whatsapp_name) {
      await tx
        .update(contacts)
        .set({ profile: { ...(contact.profile as Record<string, unknown>), whatsapp_name: input.profileName } })
        .where(eq(contacts.id, contact.id));
    }

    const [open] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.contactId, contact!.id),
          eq(conversations.channelId, channel.id),
          ne(conversations.state, "closed"),
        ),
      )
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    if (open) {
      return { conversationId: open.id, contactId: contact!.id, channelId: open.channelId };
    }
    // Sin conversacion abierta: la nueva usa el canal por el que escribio.

    const [created] = await tx
      .insert(conversations)
      .values({ tenantId: input.tenantId, contactId: contact!.id, channelId: channel.id })
      .returning();
    return { conversationId: created!.id, contactId: contact!.id, channelId: channel.id };
  });
}
