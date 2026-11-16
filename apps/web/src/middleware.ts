import { NextResponse, type NextRequest } from "next/server";

/**
 * Politica de contenido (CSP) con nonce por peticion + HTTPS estricto en produccion.
 *
 * - Los scripts solo corren si traen el nonce de ESTA respuesta ('strict-dynamic'): un
 *   script inyectado (XSS) no se ejecuta aunque llegue al HTML. Next aplica el nonce solo
 *   a sus propios scripts al leer la cabecera de la peticion.
 * - Estilos en linea permitidos: Next y Tailwind los usan; el riesgo es mucho menor que en scripts.
 * - En desarrollo se permite 'unsafe-eval' porque React lo usa para depurar (nunca en produccion).
 */
export function middleware(request: NextRequest) {
  const isProd = process.env.NODE_ENV === "production";
  const nonce = btoa(crypto.randomUUID());

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isProd ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isProd ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  if (isProd) {
    // El navegador recordara usar solo HTTPS con este dominio durante un anio.
    response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return response;
}

export const config = {
  // Todo menos archivos estaticos de Next.
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)" }],
};
