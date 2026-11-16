import type { SessionRole } from "@empleado/shared";

/** Quien actua en el panel: sale de la sesion firmada, nunca de lo que mande el navegador. */
export interface PanelContext {
  tenantId: string;
  userId: string;
  role: SessionRole;
}

export type PanelAction = "read" | "reply" | "approve" | "manage_appointments" | "playground" | "configure" | "manage_users";

/**
 * "viewer" solo mira; "agent" atiende (responder, aprobar, citas, probador);
 * solo "owner" configura el negocio y administra usuarios.
 */
export function can(role: SessionRole, action: PanelAction): boolean {
  if (action === "read") return true;
  if (action === "configure" || action === "manage_users") return role === "owner";
  return role === "owner" || role === "agent";
}

export type Failure<E extends string = string> = { ok: false; error: E };
export type Success<T = object> = { ok: true } & T;
export type Result<T = object, E extends string = string> = Success<T> | Failure<E>;

export const fail = <E extends string>(error: E): Failure<E> => ({ ok: false, error });

/** Encola el envio de un mensaje saliente (lo implementa el panel con BullMQ). */
export type EnqueueOutbound = (job: { tenantId: string; messageId: string }) => Promise<void>;

export const MAX_MESSAGE_CHARS = 3800;
