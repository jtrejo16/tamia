import { connectChannel, disconnectChannel } from "@empleado/inbox";
import { parseKey } from "@empleado/shared";
import { authed, failure, readJson, respond } from "@/lib/api";
import { env, getDb } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** connect | disconnect — solo el dueño (lo valida el dominio). */
export const POST = authed<{ action: string }>(async (req, ctx, { action }) => {
  const db = getDb();
  if (action === "connect") {
    const deps = {
      key: parseKey(env("ENCRYPTION_KEY")),
      apiVersion: process.env.GRAPH_API_VERSION || "v23.0",
      baseUrl: process.env.GRAPH_BASE_URL || undefined,
    };
    return respond(await connectChannel(db, deps, ctx, await readJson(req)));
  }
  if (action === "disconnect") return respond(await disconnectChannel(db, ctx));
  return failure("not_found");
});
