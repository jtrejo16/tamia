import { isOperator } from "@empleado/db";
import { redirect } from "next/navigation";
import { OperatorCostsView } from "@/components/operator-costs-view";
import { getDb } from "@/lib/server";
import { requireValidSession } from "@/lib/session";

export const metadata = { title: "Costos · Operador" };

export default async function OperatorCostsPage() {
  const { ctx } = await requireValidSession();
  if (!(await isOperator(getDb(), ctx.userId))) redirect("/bandeja");
  return <OperatorCostsView />;
}
