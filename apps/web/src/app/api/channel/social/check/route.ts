import { checkSocialChannels } from "@empleado/inbox";
import { authed, failure, respond } from "@/lib/api";
import { socialDeps } from "@/lib/facebook";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Comprueba con Meta que Messenger/Instagram sigan bien conectados. Solo dueño (lo valida el dominio). */
export const POST = authed(async (_req, ctx) => {
  const deps = socialDeps();
  if (!deps) return failure("payments_unavailable");
  return respond(await checkSocialChannels(getDb(), deps, ctx));
});
