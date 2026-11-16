import { addMember, changeRole, removeMember, resetMemberPassword } from "@empleado/inbox";
import { authed, failure, readJson, respond, str } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/users/(add | role | remove | reset). Solo el dueño (lo impone el dominio). */
export const POST = authed<{ action: string }>(async (req, ctx, { action }) => {
  const db = getDb();
  const body = await readJson(req);
  const userId = str(body.userId);

  switch (action) {
    case "add":
      return respond(await addMember(db, ctx, { email: str(body.email), name: str(body.name), role: str(body.role) }));
    case "role":
      return UUID.test(userId) ? respond(await changeRole(db, ctx, userId, str(body.role))) : failure("not_found");
    case "remove":
      return UUID.test(userId) ? respond(await removeMember(db, ctx, userId)) : failure("not_found");
    case "reset":
      return UUID.test(userId) ? respond(await resetMemberPassword(db, ctx, userId)) : failure("not_found");
    default:
      return failure("not_found");
  }
});
