import { operatorCosts, type CostPeriod } from "@empleado/inbox";
import { costConfigFromEnv } from "@empleado/shared";
import { NextResponse } from "next/server";
import { authed, respond } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

const PERIODS: readonly CostPeriod[] = ["month", "last_month", "30d", "7d"];

/** Costos de la plataforma (IA, llamadas, telefonía, WhatsApp/Meta, fijos) por cliente y en total. Solo operador (lo valida la base). */
export const GET = authed(async (req, ctx) => {
  const asked = new URL(req.url).searchParams.get("period") ?? "month";
  const period = (PERIODS as readonly string[]).includes(asked) ? (asked as CostPeriod) : "month";
  const result = await operatorCosts(getDb(), ctx.userId, costConfigFromEnv(process.env), period);
  if (!result.ok) return respond(result);
  return NextResponse.json(result);
});
