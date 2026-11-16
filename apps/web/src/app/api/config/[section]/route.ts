import {
  addHoliday,
  createReminderTemplates,
  removeDoc,
  removeHoliday,
  saveDoc,
  saveService,
  saveStaff,
  setHours,
  setServiceActive,
  syncTemplates,
  updateAgent,
  updateBusiness,
} from "@empleado/inbox";
import { parseKey } from "@empleado/shared";
import { authed, failure, readJson, respond, str } from "@/lib/api";
import { env, getDb } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opciones para hablar con Meta: la llave abre el token del canal (nunca sale del servidor). */
const graph = () => ({
  key: parseKey(env("ENCRYPTION_KEY")),
  apiVersion: process.env.GRAPH_API_VERSION || "v23.0",
  baseUrl: process.env.GRAPH_BASE_URL || undefined,
});

/** POST /api/config/:section — cada seccion valida y audita en el dominio. */
export const POST = authed<{ section: string }>(async (req, ctx, { section }) => {
  const db = getDb();
  const body = await readJson(req);
  const id = str(body.id);

  switch (section) {
    case "business":
      return respond(await updateBusiness(db, ctx, body));
    case "agent":
      return respond(await updateAgent(db, ctx, body));
    case "service":
      return respond(await saveService(db, ctx, body));
    case "service-active":
      return UUID.test(id) ? respond(await setServiceActive(db, ctx, id, body.active === true)) : failure("not_found");
    case "staff":
      return respond(await saveStaff(db, ctx, body));
    case "hours":
      return respond(await setHours(db, ctx, body));
    case "holiday-add":
      return respond(await addHoliday(db, ctx, body));
    case "holiday-remove":
      return UUID.test(id) ? respond(await removeHoliday(db, ctx, id)) : failure("not_found");
    case "doc":
      return respond(await saveDoc(db, ctx, body));
    case "doc-remove":
      return UUID.test(id) ? respond(await removeDoc(db, ctx, id)) : failure("not_found");
    case "templates-create":
      return respond(await createReminderTemplates(db, graph(), ctx));
    case "templates-sync":
      return respond(await syncTemplates(db, graph(), ctx.tenantId));
    default:
      return failure("not_found");
  }
});
