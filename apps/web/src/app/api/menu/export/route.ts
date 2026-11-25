import { exportMenuCsv } from "@empleado/inbox";
import { authed, respond } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** GET /api/menu/export → el menu como CSV descargable (se puede volver a importar). */
export const GET = authed(async (_req, ctx) => {
  const r = await exportMenuCsv(getDb(), ctx);
  if (!r.ok) return respond(r);
  return new Response(r.csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="menu.csv"',
      "cache-control": "no-store",
    },
  });
});
