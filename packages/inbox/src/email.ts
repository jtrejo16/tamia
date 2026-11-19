/**
 * Envio de correos (avisos al equipo, y mas adelante recuperar contraseña). Hoy con Brevo (API REST); el resto del
 * sistema solo conoce `sendEmail`, asi que cambiar de proveedor es cambiar este archivo.
 * Variables de entorno: BREVO_API_KEY, EMAIL_FROM (remitente verificado, p. ej. avisos@tamia.com.mx), EMAIL_FROM_NAME.
 */
export interface EmailDeps {
  apiKey: string;
  fromEmail: string;
  fromName: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class EmailError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Configuracion desde el entorno; null si falta algo (los avisos por correo quedan desactivados). */
export function emailDepsFromEnv(env: Record<string, string | undefined>): EmailDeps | null {
  const apiKey = env.BREVO_API_KEY?.trim();
  const fromEmail = env.EMAIL_FROM?.trim();
  if (!apiKey || !fromEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) return null;
  return { apiKey, fromEmail, fromName: env.EMAIL_FROM_NAME?.trim() || "Tamia" };
}

export async function sendEmail(deps: EmailDeps, input: { to: string; subject: string; text: string }): Promise<void> {
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${(deps.baseUrl ?? "https://api.brevo.com").replace(/\/$/, "")}/v3/smtp/email`, {
      method: "POST",
      headers: { "api-key": deps.apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: deps.fromName, email: deps.fromEmail },
        to: [{ email: input.to }],
        subject: input.subject.slice(0, 200),
        textContent: input.text,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new EmailError("sin conexion con el servicio de correo", 0);
  }
  if (!res.ok) {
    // Nunca se incluye la clave ni el cuerpo completo en el error.
    const detail = ((await res.json().catch(() => ({}))) as { message?: string }).message;
    throw new EmailError(`el servicio de correo respondio ${res.status}${detail ? `: ${String(detail).slice(0, 120)}` : ""}`, res.status);
  }
}
