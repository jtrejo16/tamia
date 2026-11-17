import { disconnectGoogleCalendar } from "@empleado/inbox";
import { authed, respond } from "@/lib/api";
import { googleDeps } from "@/lib/google";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Desconecta el calendario (solo dueño; lo valida el dominio). */
export const POST = authed(async (_req, ctx) => respond(await disconnectGoogleCalendar(getDb(), googleDeps(), ctx)));
