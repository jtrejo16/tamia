import "server-only";
import type { PanelContext } from "@empleado/inbox";
import { NextResponse, type NextRequest } from "next/server";
import { notifyChange } from "./server";
import { getValidSession } from "./session";

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
  horario_no_disponible: "Ese horario ya no está libre. Elige otro.",
  servicio_no_encontrado: "Ese servicio ya no existe o está desactivado.",
  empleado_no_disponible: "Nadie atiende ese servicio. Revisa en Ajustes quién lo ofrece.",
  fecha_invalida: "La fecha no es válida.",
  contacto_no_encontrado: "No se encontró al cliente.",
  same_contact: "Elige dos clientes distintos.",
  bad_session: "Sesión de prueba inválida.",
  invalid_credentials: "Correo o contraseña incorrectos.",
  no_membership: "Tu usuario no pertenece a ningún negocio.",
  tenant_inactive: "El negocio está pausado. Contacta a soporte.",
  must_change_password: "Primero debes cambiar tu contraseña temporal.",
  wrong_password: "La contraseña actual no es correcta.",
  weak_password: "La contraseña nueva no cumple los requisitos.",
  same_password: "La contraseña nueva debe ser distinta a la actual.",
  already_member: "Esa persona ya pertenece al negocio.",
  last_owner: "Siempre debe quedar al menos un dueño en el negocio.",
  cannot_reset:
    "No se puede restablecer esa contraseña: la persona pertenece a otro negocio o ya no existe. Pídele que use «Cambiar mi contraseña».",
  use_own_password: "Para tu propia cuenta usa «Cambiar mi contraseña» en Mi cuenta.",
  email_taken: "Ese correo ya está registrado.",
  invalid: "Revisa los datos marcados.",
  invalid_plan: "Ese plan no existe.",
  voice_channel: "Las llamadas no se responden por texto. Si el cliente tiene WhatsApp, escríbele en esa conversación.",
  retell_unavailable: "La telefonía con IA todavía no está configurada en el servidor. Contacta a soporte.",
  missing_voice: "Falta guardar los ajustes de voz y elegir una voz antes de sincronizar.",
  retell_rejected: "Retell rechazó la configuración. Revisa la voz elegida y la clave de Retell.",
  retell_down: "Retell no respondió. Inténtalo en unos minutos.",
  google_rejected: "Google rechazó la conexión. Inténtalo de nuevo.",
  google_down: "Google no respondió. Inténtalo en unos minutos.",
  no_refresh_token: "Google no entregó el permiso permanente. Vuelve a conectar y acepta todos los permisos.",
  missing_scope: "Falta el permiso de Calendar. Vuelve a conectar y deja marcada la casilla para ver y editar eventos del calendario.",
  already_connected: "Esa cuenta ya está conectada en otro negocio.",
  no_pages: "Tu cuenta de Facebook no administra ninguna página. Crea una página o pide acceso de administrador.",
  no_subscription: "Tu negocio no tiene una suscripción registrada. Contacta a soporte.",
  payments_unavailable: "El cobro en línea todavía no está disponible. Contacta a soporte.",
  provider_error: "Mercado Pago no pudo procesar la solicitud. Inténtalo de nuevo en unos minutos.",
  comped: "Tu negocio tiene una cortesía: no requiere pago.",
  no_checkout: "Todavía no has iniciado el pago de tu suscripción.",
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
  must_change_password: 403,
  wrong_password: 400,
  weak_password: 400,
  same_password: 400,
  already_member: 409,
  last_owner: 409,
  cannot_reset: 409,
  use_own_password: 400,
  email_taken: 409,
  invalid: 400,
  invalid_plan: 400,
  voice_channel: 409,
  retell_unavailable: 503,
  missing_voice: 409,
  retell_rejected: 502,
  retell_down: 503,
  already_connected: 409,
  no_pages: 409,
  no_subscription: 409,
  payments_unavailable: 503,
  provider_error: 502,
  comped: 409,
  no_checkout: 409,
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
  horario_no_disponible: 409,
  servicio_no_encontrado: 404,
  empleado_no_disponible: 409,
  fecha_invalida: 400,
  contacto_no_encontrado: 404,
  same_contact: 400,
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

type Handler<P> = (req: NextRequest, ctx: PanelContext, params: P, session: { uid: string; tid: string; sv: number }) => Promise<Response>;

/**
 * Envuelve una ruta de la API: exige una sesion VERIFICADA en la base de datos (no revocada,
 * usuario aun en el negocio, rol vigente) y, si modifica datos, el origen correcto.
 * Mientras el usuario deba cambiar su contraseña temporal solo se permiten las rutas de cuenta
 * (`allowWhileMustChange`).
 */
export function authed<P = Record<string, never>>(handler: Handler<P>, options: { allowWhileMustChange?: boolean } = {}) {
  return async (req: NextRequest, route: { params: Promise<P> }): Promise<Response> => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return failure("bad_origin");
      const valid = await getValidSession();
      if (!valid) return failure("unauthorized");
      if (valid.state.mustChangePassword && !options.allowWhileMustChange) return failure("must_change_password");
      const response = await handler(req, valid.ctx, await route.params, valid.session);
      // Una accion que modifica datos: los demas paneles abiertos se actualizan al instante.
      if (req.method !== "GET" && req.method !== "HEAD" && response.status < 400) notifyChange();
      return response;
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
