import { getValidSession } from "@/lib/session";
import { subscribeToChanges } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Tiempo real (Server-Sent Events): el navegador deja abierta esta conexion y recibe un
 * "change" cuando algo cambia (mensaje nuevo, entrega, accion de otra persona). El aviso no
 * lleva datos: el panel vuelve a pedir lo suyo por su API normal, ya filtrada por negocio y rol.
 * Si la conexion se cae, el panel sigue funcionando por consulta periodica.
 */
export async function GET(req: Request): Promise<Response> {
  const valid = await getValidSession();
  if (!valid || valid.state.mustChangePassword) return new Response(null, { status: 401 });

  const encoder = new TextEncoder();
  let cleanup: (() => Promise<void>) | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          /* ya cerrada */
        }
      };
      const close = async () => {
        if (keepAlive) clearInterval(keepAlive);
        keepAlive = null;
        await cleanup?.().catch(() => {});
        cleanup = null;
        try {
          controller.close();
        } catch {
          /* ya cerrada */
        }
      };
      req.signal.addEventListener("abort", () => void close());

      try {
        cleanup = await subscribeToChanges(() => send("event: change\ndata: 1\n\n"));
      } catch {
        return void controller.close(); // sin Redis: el cliente cae a consulta periodica
      }
      send("retry: 5000\n\nevent: ready\ndata: 1\n\n");
      // Comentario cada 20 s: evita que proxies cierren la conexion por inactividad.
      keepAlive = setInterval(() => send(": ping\n\n"), 20_000);
    },
    async cancel() {
      if (keepAlive) clearInterval(keepAlive);
      await cleanup?.().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
