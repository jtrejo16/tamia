import { redirect } from "next/navigation";
import { PanelShell } from "@/components/panel-shell";
import { llmMode } from "@/lib/server";
import { requireValidSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  // Sesion verificada contra la base de datos: revocada, dada de baja o negocio pausado => fuera.
  const { ctx, state } = await requireValidSession();
  // Contraseña temporal: no se entra al panel hasta cambiarla.
  if (state.mustChangePassword) redirect("/cuenta?obligatorio=1");

  return (
    <PanelShell
      info={{
        userId: ctx.userId,
        userName: state.userName ?? state.email,
        role: ctx.role,
        tenantName: state.tenantName,
        timezone: state.timezone,
        llmMode: llmMode(),
      }}
    >
      {children}
    </PanelShell>
  );
}
