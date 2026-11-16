import { setAppointmentStatus, type AppointmentChange } from "@empleado/inbox";
import { authed, failure, readJson, respond, str } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set<AppointmentChange>(["confirmed", "cancelled", "done", "no_show"]);

export const POST = authed<{ id: string }>(async (req, ctx, { id }) => {
  if (!UUID.test(id)) return failure("not_found");
  const status = str((await readJson(req)).status) as AppointmentChange;
  if (!STATUSES.has(status)) return failure("bad_request");
  return respond(await setAppointmentStatus(getDb(), ctx, id, status));
});
