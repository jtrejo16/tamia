import { isOperator } from "@empleado/db";
import { getBilling } from "@empleado/inbox";
import { redirect } from "next/navigation";
import { PanelShell } from "@/components/panel-shell";
import { getDb, getMercadoPago, llmMode } from "@/lib/server";
import { requireValidSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  // Sesion verificada contra la base de datos: revocada, dada de baja o negocio pausado => fuera.
  const { ctx, state } = await requireValidSession();
  // Contraseña temporal: no se entra al panel hasta cambiarla.
  if (state.mustChangePassword) redirect("/cuenta?obligatorio=1");

  const db = getDb();
  const [billing, operator] = await Promise.all([getBilling(db, ctx, getMercadoPago() !== null), isOperator(db, ctx.userId)]);

  return (
    <PanelShell
      info={{
        userId: ctx.userId,
        userName: state.userName ?? state.email,
        role: ctx.role,
        tenantName: state.tenantName,
        timezone: state.timezone,
        modules: state.modules,
        llmMode: llmMode(),
        isOperator: operator,
        access: {
          allowed: billing.access.allowed,
          reason: billing.access.reason,
          trialEndsAt: billing.subscription?.trialEndsAt?.toISOString() ?? null,
        },
      }}
    >
      {children}
    </PanelShell>
  );
}
