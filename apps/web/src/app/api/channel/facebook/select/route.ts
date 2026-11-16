import { connectSocial } from "@empleado/inbox";
import { cookies } from "next/headers";
import { authed, failure, readJson, respond, str } from "@/lib/api";
import { PAGES_COOKIE, openPages, socialDeps } from "@/lib/facebook";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** El dueño elige que pagina (y que redes) conectar. Los tokens salen de la cookie cifrada, no del navegador. */
export const POST = authed(async (req, ctx) => {
  const deps = socialDeps();
  if (!deps) return failure("payments_unavailable");
  const store = await cookies();
  const pages = openPages(store.get(PAGES_COOKIE)?.value, ctx.userId, ctx.tenantId);
  const body = await readJson(req);
  const page = pages?.find((p) => p.pageId === str(body.pageId));
  if (!page) return failure("not_found");

  const result = await connectSocial(getDb(), deps, ctx, { page, messenger: body.messenger === true, instagram: body.instagram === true });
  if (result.ok) store.delete(PAGES_COOKIE); // ya no se necesita
  return respond(result);
});
