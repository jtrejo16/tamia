import { ORDER_STATUSES } from "@empleado/db";
import { setOrderStatus } from "@empleado/inbox";
import { authed, failure, readJson, respond, str } from "@/lib/api";
import { getDb, getEnqueue } from "@/lib/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/orders/:id/status  { status: preparing | ready | delivered | cancelled, reason? } */
export const POST = authed<{ id: string }>(async (req, ctx, { id }) => {
  if (!UUID.test(id)) return failure("not_found");
  const b = await readJson(req);
  const status = str(b.status);
  if (!(ORDER_STATUSES as readonly string[]).includes(status) || status === "new") return failure("bad_request");
  return respond(await setOrderStatus(getDb(), ctx, id, status as (typeof ORDER_STATUSES)[number], { reason: str(b.reason) }, getEnqueue().outbound));
});
