import { PLANS, PLAN_IDS, TRIAL_DAYS } from "@empleado/shared/plans";
import { redirect } from "next/navigation";
import { VERTICAL_IDS } from "@empleado/shared/verticals";
import { SignupForm } from "@/components/signup-form";
import { getValidSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Crear cuenta · Jovia" };

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ giro?: string }> }) {
  if (await getValidSession()) redirect("/bandeja");
  // Las portadas por giro (por ejemplo «Para restaurantes») mandan aqui con el giro ya elegido: /registro?giro=taqueria
  const giro = (await searchParams).giro;
  const initialVertical = (VERTICAL_IDS as readonly string[]).includes(giro ?? "") ? giro : undefined;
  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-700 text-xl font-bold text-white">J</div>
          <h1 className="text-xl font-semibold text-slate-900">Prueba Jovia {TRIAL_DAYS} días gratis</h1>
          <p className="mt-1 text-sm text-slate-500">
            Un asistente que atiende y agenda por WhatsApp. Sin tarjeta para empezar; desde ${PLANS[PLAN_IDS[0]!].priceMxn} MXN al mes después.
          </p>
        </div>
        <SignupForm initialVertical={initialVertical} />
        <p className="mt-4 text-center text-sm text-slate-500">
          ¿Ya tienes cuenta? <a href="/login" className="font-medium text-teal-700 hover:underline">Inicia sesión</a>
        </p>
      </div>
    </main>
  );
}
