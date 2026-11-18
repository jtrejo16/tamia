import { isOperator } from "@empleado/db";
import { notFound, redirect } from "next/navigation";
import { OperatorTenantView } from "@/components/operator-tenant-view";
import { UUID } from "@/lib/operator";
import { getDb } from "@/lib/server";
import { requireValidSession } from "@/lib/session";

export const metadata = { title: "Cliente · Operador · Empleado Digital" };

export default async function OperatorTenantPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  // La base de datos decide quién es operador; los demás regresan a la bandeja.
  const { ctx } = await requireValidSession();
  if (!(await isOperator(getDb(), ctx.userId))) redirect("/bandeja");
  if (!UUID.test(tenant)) notFound();
  return <OperatorTenantView tenantId={tenant} />;
}
