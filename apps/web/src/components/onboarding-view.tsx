"use client";

import type { OnboardingStep } from "@empleado/inbox";
import Link from "next/link";
import { usePolling } from "@/lib/client";
import { Alert, Badge, EmptyState, Spinner, cx } from "./ui";

interface Data {
  ok: true;
  percent: number;
  doneCount: number;
  total: number;
  steps: OnboardingStep[];
  starterMenu: { template: string; reviewed: boolean } | null;
}

function Check({ done }: { done: boolean }) {
  return (
    <span
      aria-hidden
      className={cx("flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold", done ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-400 ring-1 ring-slate-300")}
    >
      {done ? "✓" : ""}
    </span>
  );
}

/** «Primeros pasos»: lo que falta para dejar listo el negocio, con el porcentaje de avance. */
export function OnboardingView() {
  const { data, loading } = usePolling<Data>("/api/onboarding", 10000);

  if (loading && !data) {
    return (
      <div className="flex justify-center p-16">
        <Spinner />
      </div>
    );
  }
  if (!data) return <EmptyState title="No se pudo cargar" hint="Actualiza la página en un momento." />;

  const complete = data.percent >= 100;
  const todo = data.steps.filter((s) => !s.done);
  const done = data.steps.filter((s) => s.done);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-5 p-4 sm:p-6">
        <header>
          <h1 className="text-lg font-semibold text-slate-900">Primeros pasos</h1>
          <p className="text-sm text-slate-500">Lo que falta para que tu asistente quede listo para atender a tus clientes.</p>
        </header>

        <section className="space-y-2 rounded-2xl bg-white p-4 ring-1 ring-slate-200" aria-label="Avance">
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-medium text-slate-700">
              {data.doneCount} de {data.total} pasos
            </p>
            <p className="text-2xl font-semibold text-teal-700">{data.percent}%</p>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={data.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Avance de los primeros pasos">
            <div className="h-full rounded-full bg-teal-600 transition-all" style={{ width: `${data.percent}%` }} />
          </div>
          {complete && <p className="text-sm text-teal-800">¡Listo! Tu negocio está configurado. Puedes volver aquí cuando quieras.</p>}
        </section>

        {data.starterMenu && !data.starterMenu.reviewed && (
          <Alert tone="amber">Empezaste con un menú de ejemplo: los platillos y precios son de referencia. Cámbialos por los tuyos en <Link href="/menu" className="font-medium underline">Menú</Link> antes de recibir pedidos reales.</Alert>
        )}

        {todo.length > 0 && (
          <ul className="space-y-2" aria-label="Pendientes">
            {todo.map((s) => (
              <li key={s.id}>
                <Link href={s.href} className="flex items-start gap-3 rounded-xl bg-white p-3 ring-1 ring-slate-200 hover:bg-slate-50">
                  <Check done={false} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-medium text-slate-900">
                      {s.label}
                      {s.optional && <Badge tone="slate">Opcional</Badge>}
                    </span>
                    <span className="block text-xs text-slate-500">{s.hint}</span>
                  </span>
                  <span className="shrink-0 pt-0.5 text-sm font-medium text-teal-700">Hacer →</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {done.length > 0 && (
          <section aria-label="Completados" className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Completados</h2>
            <ul className="space-y-1.5">
              {done.map((s) => (
                <li key={s.id} className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-slate-500">
                  <Check done />
                  <span className="line-through decoration-slate-300">{s.label}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
