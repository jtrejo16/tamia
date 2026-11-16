import { channels, withTenant, type Database } from "@empleado/db";
import { openChannelCredentials } from "@empleado/channels";
import { eq } from "drizzle-orm";

export interface ChannelAccess {
  channelId: string;
  phoneNumberId: string;
  status: "active" | "paused" | "error";
  /** Nulo si el canal aun no tiene token guardado o no se pudo descifrar. */
  accessToken: string | null;
}

/** Lee un canal y descifra su token. El token solo vive en memoria el tiempo de la llamada. */
export async function loadChannelAccess(
  db: Database,
  key: Buffer,
  tenantId: string,
  channelId: string,
): Promise<ChannelAccess | null> {
  const [channel] = await withTenant(db, { tenantId }, (tx) =>
    tx.select().from(channels).where(eq(channels.id, channelId)),
  );
  if (!channel) return null;

  let accessToken: string | null = null;
  if (channel.credentialsEnc) {
    try {
      accessToken = openChannelCredentials(channel.credentialsEnc, key, tenantId, channelId).accessToken;
    } catch {
      accessToken = null; // llave distinta o dato alterado: se trata como "sin credenciales"
    }
  }
  return {
    channelId,
    phoneNumberId: channel.externalId,
    status: channel.status,
    accessToken,
  };
}
