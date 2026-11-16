import { closeConversation, releaseControl, sendHumanMessage, takeControl } from "@empleado/inbox";
import { authed, failure, readJson, respond, str } from "@/lib/api";
import { getDb, getEnqueue } from "@/lib/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/conversations/:id/(take | release | close | send) */
export const POST = authed<{ id: string; action: string }>(async (req, ctx, { id, action }) => {
  if (!UUID.test(id)) return failure("not_found");
  const db = getDb();

  switch (action) {
    case "take":
      return respond(await takeControl(db, ctx, id));
    case "release":
      return respond(await releaseControl(db, ctx, id));
    case "close":
      return respond(await closeConversation(db, ctx, id));
    case "send": {
      const body = await readJson(req);
      const enqueue = getEnqueue().outbound;
      return respond(await sendHumanMessage(db, ctx, id, str(body.text), enqueue));
    }
    default:
      return failure("not_found");
  }
});
