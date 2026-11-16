import type {
  AgentConfig,
  Contact,
  Database,
  ProposedAction,
  Tenant,
} from "@empleado/db";

/** Confirmacion pendiente de una accion que modifica datos (crear/cambiar/cancelar cita). */
export interface PendingAction {
  tool: string;
  /** Huella de los argumentos: solo se acepta la confirmacion de ESA misma accion. */
  key: string;
  /** Mensajes del cliente al proponerla. La confirmacion debe llegar en un turno posterior. */
  inboundCount: number;
  createdAt: string;
}

/** Estado estructurado de la tarea en curso; se guarda en conversations.task_state. */
export interface TaskState {
  pendingAction?: PendingAction;
  [key: string]: unknown;
}

export interface LocationAttachment {
  type: "location";
  name?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  mapsUrl?: string;
}
export type Attachment = LocationAttachment;

/** Todo lo que una herramienta necesita para actuar en nombre de UN cliente de UN negocio. */
export interface TurnContext {
  db: Database;
  tenantId: string;
  tenant: Tenant;
  config: AgentConfig;
  conversationId: string;
  contactId: string;
  contact: Contact;
  now: Date;
  /** Mensajes del cliente en la conversacion, incluido el actual. */
  inboundCount: number;
  taskState: TaskState;
  /**
   * "dry": las acciones se validan pero NO se escriben; quedan como propuestas para que
   * un humano las apruebe (copiloto y semi-automatico). "live": se ejecutan.
   */
  mode: "live" | "dry";
  /** Solo al ejecutar acciones ya aprobadas por una persona. */
  skipConfirmation?: boolean;
  // --- salidas del turno (las llenan las herramientas) ---
  proposedActions: ProposedAction[];
  attachments: Attachment[];
  usedMutation: boolean;
  escalated: boolean;
  escalationMessage?: string;
}

export type ToolResult = Record<string, unknown>;
