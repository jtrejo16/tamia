import { getCustomer, updateCustomer } from "@empleado/inbox";
import { authed, failure, readJson, respond } from "@/lib/api";
import { getDb } from "@/lib/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 *  GET  /api/customers/:id   ficha: datos, historial de citas y estadisticas
 *  POST /api/customers/:id   edita { displayName?, phone?, email?, tags?, notes?, optedOut? } (solo lo que venga)
 */
export const GET = authed<{ id: string }>(async (_req, ctx, { id }) => {
  if (!UUID.test(id)) return failure("not_found");
  const r = await getCustomer(getDb(), ctx, id);
  return r.ok ? NextResponse.json(r) : respond(r);
});

export const POST = authed<{ id: string }>(async (req, ctx, { id }) => {
  if (!UUID.test(id)) return failure("not_found");
  const b = await readJson(req);
  const input: Record<string, unknown> = {};
  for (const k of ["displayName", "phone", "email", "tags", "notes", "optedOut"]) if (k in b) input[k] = b[k];
  return respond(await updateCustomer(getDb(), ctx, id, input));
});
