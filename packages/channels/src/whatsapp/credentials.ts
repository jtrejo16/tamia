import { decryptJson, encryptJson } from "@empleado/shared";

export interface ChannelCredentials {
  accessToken: string;
}

/** El cifrado queda ligado al canal: copiar el blob a otro canal o negocio no lo abre. */
const aad = (tenantId: string, channelId: string) => `channel:${tenantId}:${channelId}`;

export function sealChannelCredentials(
  credentials: ChannelCredentials,
  key: Buffer,
  tenantId: string,
  channelId: string,
): Buffer {
  return encryptJson(credentials, key, aad(tenantId, channelId));
}

export function openChannelCredentials(
  blob: Buffer,
  key: Buffer,
  tenantId: string,
  channelId: string,
): ChannelCredentials {
  return decryptJson<ChannelCredentials>(blob, key, aad(tenantId, channelId));
}
