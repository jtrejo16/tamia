import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Salud del panel para el balanceador y Docker. Sin datos sensibles: solo "ok" y si la base responde. */
export async function GET() {
  try {
    await getDb().execute(sql`select 1`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
