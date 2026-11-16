import { tenants, users, withTenant } from "@empleado/db";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { PanelShell } from "@/components/panel-shell";
import { getDb, llmMode } from "@/lib/server";
import { requireContext } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext();

  const info = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
    const [user] = await tx.select().from(users).where(eq(users.id, ctx.userId));
    return { tenant, user };
  });
  // Cookie valida pero usuario/negocio ya no existen: se limpia en vez de entrar en bucle.
  if (!info.tenant || !info.user || info.tenant.status !== "active") redirect("/sesion-invalida");

  return (
    <PanelShell
      info={{
        userId: ctx.userId,
        userName: info.user.name ?? info.user.email,
        role: ctx.role,
        tenantName: info.tenant.name,
        timezone: info.tenant.timezone,
        llmMode: llmMode(),
      }}
    >
      {children}
    </PanelShell>
  );
}
