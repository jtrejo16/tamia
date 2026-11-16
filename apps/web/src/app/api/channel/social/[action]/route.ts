import { disconnectSocial } from "@empleado/inbox";
import { authed, failure, readJson, respond } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** disconnect — solo el dueño (lo valida el dominio). */
export const POST = authed<{ action: string }>(async (req, ctx, { action }) => {
  if (action === "disconnect") return respond(await disconnectSocial(getDb(), ctx, (await readJson(req)).type));
  return failure("not_found");
});
