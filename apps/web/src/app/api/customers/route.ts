import { CUSTOMER_FILTERS, createCustomer, listCustomers, type CustomerFilter } from "@empleado/inbox";
import { NextResponse } from "next/server";
import { authed, readJson, respond } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 *  GET  /api/customers?q=&filter=&offset=   lista (con la cabecera de numeros)
 *  POST /api/customers                       alta manual { displayName, phone?, email?, tags?, notes? }
 */
export const GET = authed(async (req, ctx) => {
  const p = req.nextUrl.searchParams;
  const filter = p.get("filter") as CustomerFilter | null;
  const offset = Number(p.get("offset"));
  const limit = Number(p.get("limit"));
  const list = await listCustomers(getDb(), ctx, {
    q: p.get("q") ?? "",
    filter: filter && CUSTOMER_FILTERS.includes(filter) ? filter : null,
    offset: Number.isFinite(offset) ? offset : 0,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
  });
  return NextResponse.json({ ok: true, ...list });
});

export const POST = authed(async (req, ctx) => {
  const b = await readJson(req);
  return respond(await createCustomer(getDb(), ctx, { displayName: b.displayName, phone: b.phone, email: b.email, tags: b.tags, notes: b.notes }));
});
