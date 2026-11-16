import { isOperator } from "@empleado/db";
import { redirect } from "next/navigation";
import { OperatorView } from "@/components/operator-view";
import { getDb } from "@/lib/server";
import { requireValidSession } from "@/lib/session";

export const metadata = { title: "Operador · Empleado Digital" };

export default async function OperatorPage() {
  // La base de datos decide quién es operador; los demás regresan a la bandeja.
  const { ctx } = await requireValidSession();
  if (!(await isOperator(getDb(), ctx.userId))) redirect("/bandeja");
  return <OperatorView />;
}
