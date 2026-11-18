"use client";

import type { AppointmentView } from "@empleado/inbox";
import { useMemo, useState } from "react";
import { api, makeFormatters, usePolling } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { NewAppointmentDialog } from "./new-appointment-dialog";
import { canAct, usePanel } from "./panel-context";
import { Alert, Badge, Button, EmptyState, Spinner } from "./ui";

type Appointment = Serialized<AppointmentView>;

const STATUS: Record<Appointment["status"], { text: string; tone: "amber" | "green" | "slate" | "rose" | "sky" }> = {
  pending: { text: "Pendiente", tone: "amber" },
  confirmed: { text: "Confirmada", tone: "green" },
  done: { text: "Completada", tone: "sky" },
  no_show: { text: "No asistió", tone: "rose" },
  cancelled: { text: "Cancelada", tone: "slate" },
};

export function AppointmentsView() {
  const panel = usePanel();
  const fmt = useMemo(() => makeFormatters(panel.timezone), [panel.timezone]);
  const [all, setAll] = useState(false);
  const list = usePolling<{ ok: true; items: Appointment[] }>(`/api/appointments${all ? "?all=1" : ""}`, 8000);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const items = list.data?.items ?? [];

  const groups = useMemo(() => {
    const map = new Map<string, { label: string; rows: Appointment[] }>();
    for (const a of items) {
      const key = fmt.dayKey(a.startsAt);
      const g = map.get(key) ?? { label: fmt.dayLabel(a.startsAt), rows: [] };
      g.rows.push(a);
      map.set(key, g);
    }
    return [...map.values()];
  }, [items, fmt]);

  async function change(a: Appointment, status: "done" | "no_show" | "cancelled") {
    if (status === "cancelled" && !window.confirm(`¿Cancelar la cita de ${a.contact.name}?\n\nOjo: esto NO le avisa al cliente por WhatsApp; escríbele tú.`)) return;
    setBusy(a.id);
    setError(null);
    const res = await api<{ ok: true }>(`/api/appointments/${a.id}/status`, { method: "POST", body: { status } });
    if (!res.ok) setError(res.message);
    await list.reload();
    setBusy(null);
  }

  const allowed = canAct(panel.role);
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 p-4 lg:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Citas</h1>
            <p className="text-sm text-slate-500">Los próximos 30 días, en la hora de {panel.tenantName}.</p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="h-4 w-4 rounded accent-teal-700" />
              Mostrar canceladas y pasadas
            </label>
            {canAct(panel.role) && <Button onClick={() => setNewOpen(true)} className="py-1.5">+ Nueva cita</Button>}
          </div>
        </div>
        {newOpen && <NewAppointmentDialog onClose={() => setNewOpen(false)} onCreated={() => void list.reload()} />}

        {error && <Alert>{error}</Alert>}

        {list.loading && !list.data ? (
          <div className="flex justify-center p-10 text-slate-400"><Spinner /></div>
        ) : list.error && !list.data ? (
          <Alert>{list.error.message}</Alert>
        ) : groups.length === 0 ? (
          <div className="rounded-2xl bg-white py-16 ring-1 ring-slate-200">
            <EmptyState title="No hay citas próximas" hint="Las que agende el asistente (o tú con «Nueva cita») aparecerán aquí." />
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.label + g.rows[0]!.id}>
              <h2 className="mb-2 text-sm font-semibold text-slate-700">{g.label}</h2>
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
                {g.rows.map((a) => {
                  const s = STATUS[a.status];
                  const active = a.status === "pending" || a.status === "confirmed";
                  return (
                    <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                      <div className="w-24 shrink-0">
                        <p className="font-semibold tabular-nums text-slate-900">{fmt.time(a.startsAt)}</p>
                        <p className="text-xs text-slate-400">a {fmt.time(a.endsAt)}</p>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-slate-900">{a.contact.name}</p>
                        <p className="truncate text-sm text-slate-500">{a.service.name} · {a.staff.name}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge tone={s.tone}>{s.text}</Badge>
                        {a.confirmedByContact && <Badge tone="green">✓ Cliente confirmó</Badge>}
                      </div>
                      {active && allowed && (
                        <div className="flex gap-1.5">
                          <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => change(a, "done")} loading={busy === a.id}>Completada</Button>
                          <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => change(a, "no_show")} disabled={busy === a.id}>No asistió</Button>
                          <Button variant="danger" className="px-2.5 py-1 text-xs" onClick={() => change(a, "cancelled")} disabled={busy === a.id}>Cancelar</Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
