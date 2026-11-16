import { runPlaygroundTurn } from "@empleado/inbox";
import { authed, readJson, respond, str } from "@/lib/api";
import { getDb, getLLM } from "@/lib/server";

export const dynamic = "force-dynamic";
// Una respuesta con modelo gratuito puede tardar mas de un minuto.
export const maxDuration = 180;

export const POST = authed(async (req, ctx) => {
  const body = await readJson(req);
  return respond(await runPlaygroundTurn(getDb(), getLLM(), ctx, { text: str(body.text), sessionKey: str(body.sessionKey) }));
});
