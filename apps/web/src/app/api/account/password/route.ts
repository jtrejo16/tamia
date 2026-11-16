import { changeOwnPassword } from "@empleado/inbox";
import { authed, failure, readJson, respond, str } from "@/lib/api";
import { getDb, getLimiter } from "@/lib/server";
import { startSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export const POST = authed(
  async (req, ctx, _params, session) => {
    // Pedir la contraseña actual no debe poder usarse para adivinarla con una sesion robada.
    try {
      if (!(await getLimiter().allow(`pw-change:${ctx.userId}`, 10, 900))) return failure("rate_limited");
    } catch {
      /* si Redis falla, no se bloquea */
    }
    const body = await readJson(req);
    const result = await changeOwnPassword(getDb(), ctx, str(body.current), str(body.next));
    if (result.ok) {
      // Las demas sesiones quedan cerradas; esta sigue con la version nueva.
      await startSession({ uid: session.uid, tid: session.tid, sv: result.sessionVersion });
    }
    return respond(result);
  },
  { allowWhileMustChange: true },
);
