import { operatorChangeComped, operatorChangeStatus, operatorChangeVertical, operatorExtendTrial } from "@empleado/inbox";
import { authed, failure, readJson, respond, str } from "@/lib/api";
import { UUID } from "@/lib/operator";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** status | comped | extend-trial | vertical — el permiso lo valida la base de datos (users.is_operator). */
export const POST = authed<{ action: string }>(async (req, ctx, { action }) => {
  const body = await readJson(req);
  const tenantId = str(body.tenantId);
  if (!UUID.test(tenantId)) return failure("bad_request");
  if (action === "status") return respond(await operatorChangeStatus(getDb(), ctx.userId, tenantId, body.status));
  if (action === "comped") return respond(await operatorChangeComped(getDb(), ctx.userId, tenantId, body.on === true));
  if (action === "vertical") return respond(await operatorChangeVertical(getDb(), ctx.userId, tenantId, body.vertical));
  if (action === "extend-trial") return respond(await operatorExtendTrial(getDb(), ctx.userId, tenantId, body.days));
  return failure("not_found");
});
