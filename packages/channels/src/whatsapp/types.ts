/** Tipo de mensaje tal como se guarda en la tabla messages. */
export type StoredMessageType = "text" | "audio" | "image" | "document" | "location" | "interactive";

/** Mensaje entrante ya normalizado (independiente del formato crudo de Meta). */
export interface InboundMessage {
  /** wamid: id unico del mensaje en WhatsApp. Base de la idempotencia. */
  id: string;
  /** wa_id del cliente: solo digitos, sin "+". */
  from: string;
  /** Segundos desde epoch. */
  timestamp: number;
  type: StoredMessageType;
  /** Texto que "lee" el agente: cuerpo, leyenda o descripcion. Puede ser vacio (audio). */
  text: string;
  mediaId?: string;
  mimeType?: string;
  /** id del boton o de la fila de lista que toco el cliente. */
  replyPayload?: string;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
}

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";

export interface StatusEvent {
  /** wamid del mensaje saliente al que se refiere. */
  id: string;
  status: DeliveryStatus;
  recipientId?: string;
  timestamp: number;
  errorCode?: number;
  errorTitle?: string;
  errorMessage?: string;
}

export interface ParsedWebhook {
  messages: Array<{ phoneNumberId: string; contactName?: string; message: InboundMessage }>;
  statuses: Array<{ phoneNumberId: string; status: StatusEvent }>;
  /** Eventos que no requieren accion (reacciones, tipos no soportados, otros campos). */
  ignored: number;
}

// ----- datos que viajan por las colas (JSON puro) -----

export interface InboundJobData {
  tenantId: string;
  channelId: string;
  phoneNumberId: string;
  contactName?: string;
  message: InboundMessage;
}

export interface StatusJobData {
  tenantId: string;
  channelId: string;
  status: StatusEvent;
}

export interface OutboundJobData {
  tenantId: string;
  messageId: string;
}
