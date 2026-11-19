/**
 * Plantillas de WhatsApp. Fuera de la ventana de 24 h (y para avisos que salen sin que el
 * cliente haya escrito, como los recordatorios) WhatsApp SOLO permite plantillas aprobadas.
 */

export type TemplateCategory = "UTILITY" | "MARKETING" | "AUTHENTICATION";

export interface TemplateDefinition {
  name: string;
  language: string;
  category: TemplateCategory;
  /** Texto del cuerpo con variables {{1}}, {{2}}... */
  body: string;
  /** Ejemplos que Meta exige para revisar cada variable (mismo orden). */
  examples: string[];
  /** Botones de respuesta rapida (maximo 3). */
  quickReplies: string[];
}

export type ReminderKind = "24h" | "2h";

/** Parametros de los recordatorios, en el orden de las variables de la plantilla. */
export interface ReminderParams {
  customerName: string;
  service: string;
  /** "martes 2 de marzo a las 10:00" */
  when: string;
  business: string;
}

export const REMINDER_TEMPLATE_NAMES: Record<ReminderKind, string> = {
  "24h": "recordatorio_cita_24h",
  "2h": "recordatorio_cita_2h",
};

const EXAMPLE = ["Ana", "limpieza dental", "martes 2 de marzo a las 10:00", "Clínica Dental Sonrisa"];

export const REMINDER_TEMPLATES: Record<ReminderKind, TemplateDefinition> = {
  "24h": {
    name: REMINDER_TEMPLATE_NAMES["24h"],
    language: "es_MX",
    category: "UTILITY",
    body: "Hola {{1}}, te recordamos tu cita de {{2}} el {{3}} en {{4}}. ¿Nos confirmas tu asistencia?",
    examples: EXAMPLE,
    quickReplies: ["Confirmo", "Reagendar"],
  },
  "2h": {
    name: REMINDER_TEMPLATE_NAMES["2h"],
    language: "es_MX",
    category: "UTILITY",
    body: "Hola {{1}}, tu cita de {{2}} es hoy, {{3}}, en {{4}}. ¿Nos confirmas que vienes?",
    examples: EXAMPLE,
    quickReplies: ["Confirmo", "Reagendar"],
  },
};

/**
 * Aviso al EQUIPO cuando una conversacion necesita a una persona. Se manda desde el numero del negocio al WhatsApp del
 * equipo. Meta no admite una variable al inicio ni al final del texto, por eso cierra con "Gracias.".
 * Variables: 1 negocio, 2 cliente, 3 canal, 4 motivo, 5 enlace a la conversacion.
 */
export const STAFF_ALERT_TEMPLATE: TemplateDefinition = {
  name: "aviso_atencion_humana",
  language: "es_MX",
  category: "UTILITY",
  body: "Aviso de {{1}}: {{2}} escribió por {{3}} y necesita que una persona lo atienda. Motivo: {{4}}. Abre la conversación aquí: {{5}} Gracias.",
  examples: ["Estética Luna", "Laura Méndez", "WhatsApp", "pidió hablar con una persona", "https://app.tamia.com.mx/bandeja?c=0000"],
  quickReplies: [],
};

export const staffAlertParamList = (p: { business: string; customer: string; channel: string; reason: string; url: string }): string[] => [
  oneLine(p.business, 60),
  oneLine(p.customer, 60),
  oneLine(p.channel, 20),
  oneLine(p.reason, 160),
  p.url,
];

/**
 * Solicitud de resena despues de la cita. Texto NEUTRO a proposito: pedir la resena solo a quien quedo contento, o dar
 * algo a cambio, va contra las reglas de Google. Variables: 1 cliente, 2 negocio, 3 enlace.
 */
export const REVIEW_REQUEST_TEMPLATE: TemplateDefinition = {
  name: "solicitud_resena",
  language: "es_MX",
  category: "UTILITY",
  body: "Hola {{1}}, gracias por tu visita a {{2}} y por elegirnos. Tu opinión nos ayuda a mejorar y a que más personas nos conozcan: ¿nos dejas una reseña? Solo toma un minuto: {{3}} ¡Gracias!",
  examples: ["Laura", "Estética Luna", "https://g.page/r/ejemplo/review"],
  quickReplies: [],
};

export const reviewParamList = (p: { customer: string; business: string; url: string }): string[] => [oneLine(p.customer, 40), oneLine(p.business, 60), p.url];

/** Meta no admite saltos de linea, tabulaciones ni mas de 4 espacios seguidos dentro de una variable. */
export function oneLine(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return (clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean) || "—";
}

export const reminderParamList = (p: ReminderParams): string[] => [p.customerName, p.service, p.when, p.business];

/** El texto tal como lo ve el cliente (para mostrarlo en el panel y en el historial). */
export function renderTemplateBody(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1] ?? "");
}

/** Cuerpo en el formato que espera la API de Meta al CREAR la plantilla. */
export function toMetaTemplate(def: TemplateDefinition) {
  return {
    name: def.name,
    language: def.language,
    category: def.category,
    components: [
      { type: "BODY", text: def.body, example: { body_text: [def.examples] } },
      ...(def.quickReplies.length > 0
        ? [{ type: "BUTTONS", buttons: def.quickReplies.map((text) => ({ type: "QUICK_REPLY", text })) }]
        : []),
    ],
  };
}

/** Identificadores de los botones: llevan la cita, para saber a cual se refiere la respuesta. */
export const buttonPayloads = (appointmentId: string) => [`rem:confirm:${appointmentId}`, `rem:resched:${appointmentId}`];

export type ReminderAction = { action: "confirm" | "resched"; appointmentId: string };

export function parseReminderPayload(payload: string | undefined): ReminderAction | null {
  const m = /^rem:(confirm|resched):([0-9a-f-]{36})$/i.exec(payload ?? "");
  return m ? { action: m[1] as ReminderAction["action"], appointmentId: m[2]! } : null;
}

/** Lo que se guarda en messages.body de un mensaje de plantilla. */
export interface TemplateMessageBody {
  kind: "template";
  name: string;
  language: string;
  params: string[];
  buttons: string[];
  /** El texto ya renderizado (lo que ve el cliente). */
  text: string;
}

export function encodeTemplateMessage(def: TemplateDefinition, params: string[], payloads: string[]): string {
  const body: TemplateMessageBody = {
    kind: "template",
    name: def.name,
    language: def.language,
    params,
    buttons: payloads,
    text: renderTemplateBody(def.body, params),
  };
  return JSON.stringify(body);
}

export function decodeTemplateMessage(raw: string | null | undefined): TemplateMessageBody | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TemplateMessageBody>;
    return parsed.kind === "template" && typeof parsed.name === "string" && Array.isArray(parsed.params)
      ? (parsed as TemplateMessageBody)
      : null;
  } catch {
    return null;
  }
}
