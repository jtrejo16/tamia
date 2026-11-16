import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { readSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await readSession()) redirect("/bandeja");
  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-700 text-xl font-bold text-white">E</div>
          <h1 className="text-xl font-semibold text-slate-900">Empleado Digital</h1>
          <p className="mt-1 text-sm text-slate-500">Inicia sesión para atender a tus clientes</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
