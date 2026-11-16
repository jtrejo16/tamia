/** Ventana de servicio de WhatsApp: 24 h desde el ultimo mensaje del CLIENTE. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Dentro de la ventana se puede enviar texto libre; fuera, solo plantillas aprobadas. */
export function isWithinServiceWindow(lastInboundAt: Date | null | undefined, now: Date): boolean {
  if (!lastInboundAt) return false;
  const elapsed = now.getTime() - lastInboundAt.getTime();
  return elapsed >= 0 && elapsed < SERVICE_WINDOW_MS;
}

/** Cuando se cierra la ventana (para el reloj del panel). Nulo si nunca se abrio. */
export function windowClosesAt(lastInboundAt: Date | null | undefined): Date | null {
  return lastInboundAt ? new Date(lastInboundAt.getTime() + SERVICE_WINDOW_MS) : null;
}
