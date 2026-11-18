import { bookingCatalog, freeSlots, getContactRelations, searchBookingContacts } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed, failure, respond } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Datos para el formulario "Nueva cita":
 *  ?what=catalog                                  → servicios con sus especialistas
 *  ?what=contacts&q=texto                         → clientes que coinciden
 *  ?what=slots&serviceId=…&day=AAAA-MM-DD[&staffId=…] → horarios libres de ese día
 */
export const GET = authed(async (req, ctx) => {
  const p = req.nextUrl.searchParams;
  switch (p.get("what")) {
    case "catalog":
      return NextResponse.json({ ok: true, ...(await bookingCatalog(getDb(), ctx)) });
    case "contacts":
      return NextResponse.json({ ok: true, items: await searchBookingContacts(getDb(), ctx, p.get("q") ?? "") });
    case "relations": {
      const contactId = p.get("contactId") ?? "";
      if (!UUID.test(contactId)) return failure("bad_request");
      return NextResponse.json({ ok: true, relations: await getContactRelations(getDb(), ctx, contactId) });
    }
    case "slots": {
      const serviceId = p.get("serviceId") ?? "";
      const staffId = p.get("staffId") ?? "";
      const day = p.get("day") ?? "";
      if (!UUID.test(serviceId) || !DAY.test(day) || (staffId && !UUID.test(staffId))) return failure("bad_request");
      return respond(await freeSlots(getDb(), ctx, { serviceId, day, ...(staffId ? { staffId } : {}) }));
    }
    default:
      return failure("bad_request");
  }
});
