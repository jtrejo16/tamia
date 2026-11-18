import { connectSocial, logSupportAction, operatorSupportContext } from "@empleado/inbox";
import { cookies } from "next/headers";
import { authed, failure, readJson, respond, str } from "@/lib/api";
import { OP_PAGES_COOKIE, openPages, socialDeps } from "@/lib/facebook";
import { UUID } from "@/lib/operator";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Soporte: el operador elige que pagina (y redes) conectar al cliente. Los tokens salen de la cookie cifrada, no del navegador. */
export const POST = authed(async (req, ctx) => {
  const db = getDb();
  const body = await readJson(req);
  const tenantId = str(body.tenantId);
  if (!UUID.test(tenantId)) return failure("bad_request");
  const sctx = await operatorSupportContext(db, ctx.userId, tenantId);
  if (!sctx) return failure("forbidden");
  const deps = socialDeps();
  if (!deps) return failure("payments_unavailable");

  const store = await cookies();
  const pages = openPages(store.get(OP_PAGES_COOKIE)?.value, ctx.userId, tenantId);
  const page = pages?.find((p) => p.pageId === str(body.pageId));
  if (!page) return failure("not_found");

  const result = await connectSocial(db, deps, sctx, { page, messenger: body.messenger === true, instagram: body.instagram === true });
  if (result.ok) {
    store.delete(OP_PAGES_COOKIE);
    await logSupportAction(db, sctx, "social_connect", { page: page.name, connected: result.connected });
  }
  return respond(result);
});
