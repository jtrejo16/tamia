import { operatorChangeComped, operatorChangeStatus } from "@empleado/inbox";
import { authed, failure, readJson, respond, str } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** status | comped — el permiso lo valida la base de datos (users.is_operator). */
export const POST = authed<{ action: string }>(async (req, ctx, { action }) => {
  const body = await readJson(req);
  const tenantId = str(body.tenantId);
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) return failure("bad_request");
  if (action === "status") return respond(await operatorChangeStatus(getDb(), ctx.userId, tenantId, body.status));
  if (action === "comped") return respond(await operatorChangeComped(getDb(), ctx.userId, tenantId, body.on === true));
  return failure("not_found");
});
