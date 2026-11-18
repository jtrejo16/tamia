import { dismissPossibleSame, mergeContacts } from "@empleado/inbox";
import { authed, failure, readJson, respond, str } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 *  POST /api/contacts/merge    { keepId, mergeId }      une dos contactos que son la misma persona
 *  POST /api/contacts/dismiss  { contactId, otherId }   "no es la misma persona": deja de sugerirse
 */
export const POST = authed<{ action: string }>(async (req, ctx, { action }) => {
  const b = await readJson(req);
  if (action === "merge") {
    const keepId = str(b.keepId);
    const mergeId = str(b.mergeId);
    if (!UUID.test(keepId) || !UUID.test(mergeId)) return failure("bad_request");
    return respond(await mergeContacts(getDb(), ctx, { keepId, mergeId }));
  }
  if (action === "dismiss") {
    const contactId = str(b.contactId);
    const otherId = str(b.otherId);
    if (!UUID.test(contactId) || !UUID.test(otherId)) return failure("bad_request");
    return respond(await dismissPossibleSame(getDb(), ctx, contactId, otherId));
  }
  return failure("not_found");
});
