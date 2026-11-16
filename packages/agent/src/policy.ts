export type Autonomy = "copilot" | "semi" | "auto";
export type OutputDecision = "send" | "draft";

/** En copiloto y semi-automatico las acciones solo se proponen; en autopiloto se ejecutan. */
export function modeFor(autonomy: Autonomy): "live" | "dry" {
  return autonomy === "auto" ? "live" : "dry";
}

/**
 * Que hacer con la respuesta redactada:
 *  - copiloto: siempre borrador para que una persona lo apruebe;
 *  - semi: se envia sola si es una respuesta informativa; si propone una accion
 *    (cita) o escala a un humano, pide aprobacion;
 *  - autopiloto: se envia.
 */
export function decideOutput(input: {
  autonomy: Autonomy;
  hasProposedActions: boolean;
  escalated: boolean;
}): OutputDecision {
  switch (input.autonomy) {
    case "copilot":
      return "draft";
    case "semi":
      return input.hasProposedActions || input.escalated ? "draft" : "send";
    case "auto":
      return "send";
  }
}
