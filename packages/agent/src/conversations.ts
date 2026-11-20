import { channels, contactIdentities, contacts, conversations, withTenant, type Database } from "@empleado/db";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { phoneVariants } from "./contact-match";

export interface EnsureConversationInput {
  tenantId: string;
  /** Telefono del cliente en formato E.164, por ejemplo +529991234567. Obligatorio salvo con `identity`. */
  phone?: string;
  /**
   * Cliente de Messenger/Instagram: se identifica por el id que da la red (PSID/IGSID), unico por
   * pagina o cuenta, y puede no tener telefono todavia.
   */
  identity?: { externalId: string };
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

    let contact: typeof contacts.$inferSelect | undefined;
    if (input.identity) {
      const find = async () => {
        const [row] = await tx
          .select({ c: contacts })
          .from(contactIdentities)
          .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
          .where(and(eq(contactIdentities.channelId, channel.id), eq(contactIdentities.externalId, input.identity!.externalId)));
        return row?.c;
      };
      contact = await find();
      if (!contact) {
        const [created] = await tx
          .insert(contacts)
          .values({
            tenantId: input.tenantId,
            displayName: input.name ?? null,
            profile: input.profileName ? { [`${channel.type}_name`]: input.profileName } : {},
          })
          .returning();
        // Carrera: dos mensajes del mismo cliente nuevo a la vez. El indice unico decide quien gana.
        const claimed = await tx
          .insert(contactIdentities)
          .values({ tenantId: input.tenantId, contactId: created!.id, channelType: channel.type, channelId: channel.id, externalId: input.identity.externalId })
          .onConflictDoNothing()
          .returning({ id: contactIdentities.id });
        if (claimed.length === 0) {
          await tx.delete(contacts).where(eq(contacts.id, created!.id));
          contact = await find();
        } else contact = created;
      }
    } else {
      if (!input.phone) throw new Error("Falta el telefono o la identidad del cliente");
      const found = await tx.select().from(contacts).where(inArray(contacts.phoneE164, phoneVariants(input.phone)));
      contact = found.find((c) => c.phoneE164 === input.phone) ?? found[0];
    }
    if (!input.identity && !contact) {
      // Carrera: dos mensajes del mismo cliente nuevo a la vez. El indice unico decide.
      await tx
        .insert(contacts)
        .values({
          tenantId: input.tenantId,
          phoneE164: input.phone!,
          displayName: input.name ?? null,
          profile: input.profileName ? { whatsapp_name: input.profileName } : {},
        })
        .onConflictDoNothing();
      [contact] = await tx.select().from(contacts).where(eq(contacts.phoneE164, input.phone!));
    } else if (!input.identity && contact && input.profileName && !(contact.profile as Record<string, unknown>)?.whatsapp_name) {
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
