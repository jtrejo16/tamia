import { createManualAppointment, listAppointments } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed, failure, readJson, respond, str } from "@/lib/api";
import { getDb, getEnqueue } from "@/lib/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = authed(async (req, ctx) => {
  const includeInactive = req.nextUrl.searchParams.get("all") === "1";
  return NextResponse.json({ ok: true, items: await listAppointments(getDb(), ctx, { includeInactive }) });
});

/** Agenda una cita a mano (una persona del equipo) a nombre de un cliente; puede avisarle en la conversación. */
export const POST = authed(async (req, ctx) => {
  const b = await readJson(req);
  const contactId = str(b.contactId);
  const serviceId = str(b.serviceId);
  const staffId = str(b.staffId);
  const conversationId = str(b.conversationId);
  const startIso = str(b.startIso);
  if (!UUID.test(contactId) || !UUID.test(serviceId) || !UUID.test(staffId) || Number.isNaN(Date.parse(startIso))) return failure("bad_request");
  if (conversationId && !UUID.test(conversationId)) return failure("bad_request");
  return respond(
    await createManualAppointment(
      getDb(),
      ctx,
      { contactId, serviceId, staffId, startIso, ...(conversationId ? { conversationId } : {}), notify: b.notify === true },
      getEnqueue().outbound,
    ),
  );
});
