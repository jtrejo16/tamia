import { approveDraft, discardDraft } from "@empleado/inbox";
import { authed, failure, readJson, respond } from "@/lib/api";
import { getDb, getEnqueue } from "@/lib/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/approvals/:id/(approve | discard) */
export const POST = authed<{ id: string; action: string }>(async (req, ctx, { id, action }) => {
  if (!UUID.test(id)) return failure("not_found");
  const db = getDb();

  if (action === "approve") {
    const body = await readJson(req);
    const text = typeof body.text === "string" ? body.text : undefined;
    return respond(await approveDraft(db, ctx, id, { text }, getEnqueue().outbound));
  }
  if (action === "discard") return respond(await discardDraft(db, ctx, id));
  return failure("not_found");
});
