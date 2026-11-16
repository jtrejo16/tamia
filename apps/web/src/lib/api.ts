import "server-only";
import type { PanelContext } from "@empleado/inbox";
import { NextResponse, type NextRequest } from "next/server";
import { readSession, toContext } from "./session";

/** Mensajes en espanol para los codigos de error del dominio. */
const MESSAGES: Record<string, string> = {
  forbidden: "Tu rol no permite esta acción.",
  not_found: "No se encontró. Puede que ya no exista.",
  conversation_closed: "La conversación está cerrada.",
  not_in_control: "Primero toma el control de la conversación para poder responder.",
  window_closed: "Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp solo permite plantillas.",
  empty: "Escribe un mensaje.",
  too_long: "El mensaje es demasiado largo.",
  already_reviewed: "Este borrador ya fue revisado por alguien más.",
  conversation_in_human_control: "Una persona tiene el control de esta conversación.",
  actions_failed: "No se pudo ejecutar lo que proponía el asistente. No se envió nada.",
  invalid_transition: "Ese cambio de estado no es válido para esta cita.",
  slot_taken: "Ese horario ya está ocupado.",
  bad_session: "Sesión de prueba inválida.",
  invalid_credentials: "Correo o contraseña incorrectos.",
  no_membership: "Tu usuario no pertenece a ningún negocio.",
  tenant_inactive: "El negocio está pausado. Contacta a soporte.",
  invalid: "Revisa los datos marcados.",
  no_channel: "El negocio no tiene un número de WhatsApp conectado.",
  no_token: "El número de WhatsApp todavía no tiene su clave de acceso guardada.",
  no_waba: "Falta indicar la cuenta de WhatsApp Business del número.",
  meta_rejected: "WhatsApp (Meta) rechazó la operación.",
  meta_unavailable: "WhatsApp (Meta) no respondió. Inténtalo en unos minutos.",
  rate_limited: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
  unauthorized: "Tu sesión terminó. Vuelve a iniciar sesión.",
  bad_origin: "Petición no permitida.",
  bad_request: "Datos inválidos.",
};

const STATUS: Record<string, number> = {
  unauthorized: 401,
  invalid_credentials: 401,
  forbidden: 403,
  bad_origin: 403,
  not_found: 404,
  rate_limited: 429,
  bad_request: 400,
  invalid: 400,
  no_channel: 409,
  no_token: 409,
  no_waba: 409,
  meta_rejected: 502,
  meta_unavailable: 503,
  empty: 400,
  too_long: 400,
  bad_session: 400,
  already_reviewed: 409,
  not_in_control: 409,
  conversation_in_human_control: 409,
  conversation_closed: 409,
  window_closed: 409,
  actions_failed: 409,
  invalid_transition: 409,
  slot_taken: 409,
};

export function failure(error: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json(
    { ok: false, error, message: MESSAGES[error] ?? "Ocurrió un error.", ...extra },
    { status: STATUS[error] ?? 500 },
  );
}

/** Convierte el resultado de una funcion del dominio en respuesta HTTP. */
export function respond(result: { ok: boolean } & Record<string, unknown>): NextResponse {
  if (result.ok) return NextResponse.json(result);
  const { ok: _ok, error, ...extra } = result;
  return failure(String(error), extra);
}

/**
 * Defensa contra CSRF en peticiones que modifican datos: el navegador siempre manda `Origin`
 * y debe coincidir con el servidor. (La cookie ademas es SameSite=Lax.)
 */
export function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

type Handler<P> = (req: NextRequest, ctx: PanelContext, params: P) => Promise<Response>;

/** Envuelve una ruta de la API: exige sesion y, si modifica datos, el origen correcto. */
export function authed<P = Record<string, never>>(handler: Handler<P>) {
  return async (req: NextRequest, route: { params: Promise<P> }): Promise<Response> => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return failure("bad_origin");
      const session = await readSession();
      if (!session) return failure("unauthorized");
      return await handler(req, toContext(session), await route.params);
    } catch (error) {
      console.error(`[api] ${req.method} ${req.nextUrl.pathname}:`, error);
      return NextResponse.json({ ok: false, error: "server_error", message: "Error interno. Intenta de nuevo." }, { status: 500 });
    }
  };
}

export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const str = (v: unknown): string => (typeof v === "string" ? v : "");
