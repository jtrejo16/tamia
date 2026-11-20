"use client";

import type { AppointmentView, CustomerList } from "@empleado/inbox";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api, makeFormatters, usePolling } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { ChannelBadges, SegmentBadge, dateFormatter, percent, prettyPhone } from "./customer-ui";
import { canAct, usePanel } from "./panel-context";
import { Alert, Avatar, Badge, Button, EmptyState, Spinner, cx } from "./ui";

type List = Serialized<CustomerList>;
type Appointment = Serialized<AppointmentView>;

const field = "w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-900 ring-1 ring-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600";

type Tab = "todos" | "prospecto" | "nuevo" | "recurrente" | "en_riesgo" | "perdido" | "inasistencias" | "porcerrar";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "todos", label: "Todos" },
  { id: "prospecto", label: "Prospectos" },
  { id: "nuevo", label: "Nuevos" },
  { id: "recurrente", label: "Recurrentes" },
  { id: "en_riesgo", label: "En riesgo" },
  { id: "perdido", label: "Perdidos" },
  { id: "inasistencias", label: "Con inasistencias" },
  { id: "porcerrar", label: "Por cerrar" },
];

function Stat({ label, value, hint, tone }: { label: string; value: string | number; hint?: string; tone?: "amber" | "rose" }) {
  return (
    <div className="rounded-xl bg-white px-4 py-3 shadow-sm ring-1 ring-slate-200" title={hint}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={cx("mt-0.5 text-2xl font-semibold tabular-nums", tone === "amber" ? "text-amber-700" : tone === "rose" ? "text-rose-700" : "text-slate-900")}>{value}</p>
    </div>
  );
}

export function CustomersView() {
  const panel = usePanel();
  const date = useMemo(() => dateFormatter(panel.timezone), [panel.timezone]);
  const [tab, setTab] = useState<Tab>("todos");
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(50);
  const [newOpen, setNewOpen] = useState(false);

  // El buscador espera a que termines de escribir.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(input.trim());
      setLimit(50);
    }, 300);
    return () => clearTimeout(t);
  }, [input]);

  const filter = tab === "todos" || tab === "porcerrar" ? "" : `&filter=${tab}`;
  const list = usePolling<{ ok: true } & List>(`/api/customers?q=${encodeURIComponent(q)}${filter}&limit=${limit}`, 20000);
  const close = usePolling<{ ok: true; items: Appointment[] }>("/api/customers/to-close", 20000);
  const toClose = close.data?.items ?? [];
  const s = list.data?.summary;

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 p-4 lg:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Clientes</h1>
            <p className="text-sm text-slate-500">Quiénes son, cuándo vinieron y si han vuelto.</p>
          </div>
          {canAct(panel.role) && <Button onClick={() => setNewOpen(true)} className="py-1.5">+ Nuevo cliente</Button>}
        </div>
        {newOpen && <NewCustomerDialog onClose={() => setNewOpen(false)} onCreated={() => void list.reload()} />}

        {s && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Clientes" value={s.total} />
            <Stat label="Nuevos (30 días)" value={s.newLast30} hint="Dados de alta en los últimos 30 días." />
            <Stat label="Recurrentes" value={s.recurring} hint="Ya vinieron 2 o más veces y no están en riesgo." />
            <Stat label="Han vuelto" value={percent(s.returnRate)} hint="De quienes ya vinieron al menos una vez, cuántos volvieron a venir." />
            <Stat label="No asisten" value={percent(s.noShowRate)} hint="Inasistencias entre citas realizadas e inasistencias." tone={s.noShowRate !== null && s.noShowRate >= 0.2 ? "rose" : undefined} />
            <Stat label="En riesgo" value={s.atRisk} hint="Más de 60 días sin venir y sin cita próxima." tone={s.atRisk > 0 ? "amber" : undefined} />
          </div>
        )}

        {toClose.length > 0 && tab !== "porcerrar" && (
          <button
            onClick={() => setTab("porcerrar")}
            className="flex w-full items-center justify-between gap-3 rounded-xl bg-amber-50 px-4 py-2.5 text-left text-sm text-amber-900 ring-1 ring-amber-200 hover:bg-amber-100"
          >
            <span>
              <b>{toClose.length}</b> {toClose.length === 1 ? "cita ya pasó" : "citas ya pasaron"} y falta marcar si el cliente vino. Sin eso, las estadísticas salen bajas.
            </span>
            <span className="shrink-0 font-semibold underline">Cerrar citas</span>
          </button>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setTab(t.id);
                setLimit(50);
              }}
              className={cx(
                "rounded-full px-3 py-1 text-sm font-medium ring-1 transition-colors",
                tab === t.id ? "bg-teal-700 text-white ring-teal-700" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50",
              )}
            >
              {t.label}
              {t.id === "porcerrar" && toClose.length > 0 && <span className="ml-1.5 rounded-full bg-amber-500 px-1.5 text-xs text-white">{toClose.length}</span>}
            </button>
          ))}
        </div>

        {tab === "porcerrar" ? (
          <ToClose items={toClose} loading={close.loading && !close.data} error={close.error?.message} reload={async () => { await Promise.all([close.reload(), list.reload()]); }} />
        ) : (
          <>
            <input className={field} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Buscar por nombre, teléfono o correo" aria-label="Buscar clientes" />
            {list.loading && !list.data ? (
              <div className="flex justify-center p-10 text-slate-400"><Spinner /></div>
            ) : list.error && !list.data ? (
              <Alert>{list.error.message}</Alert>
            ) : list.data && list.data.items.length === 0 ? (
              <div className="rounded-2xl bg-white py-16 ring-1 ring-slate-200">
                <EmptyState
                  title={q || tab !== "todos" ? "No hay clientes con ese filtro" : "Todavía no hay clientes"}
                  hint={q || tab !== "todos" ? "Prueba con otra búsqueda o quita el filtro." : "Aparecen solos cuando alguien escribe o llama, o puedes agregarlos con «Nuevo cliente»."}
                />
              </div>
            ) : (
              <>
                <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
                  {list.data?.items.map((c) => (
                    <li key={c.id}>
                      <Link href={`/clientes/${c.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-slate-50">
                        <Avatar name={c.name} />
                        <div className="min-w-0 flex-1 basis-48">
                          <p className="truncate font-medium text-slate-900">{c.name}</p>
                          <p className="truncate text-sm text-slate-500">
                            {prettyPhone(c.phone)}
                            {c.email ? ` · ${c.email}` : ""}
                          </p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <ChannelBadges channels={c.channels} />
                            {c.tags.slice(0, 3).map((t) => (
                              <Badge key={t} tone="teal">{t}</Badge>
                            ))}
                          </div>
                        </div>
                        <div className="w-28 shrink-0 text-sm">
                          <p className="text-xs text-slate-400">Última visita</p>
                          <p className="text-slate-700">{date(c.lastVisitAt)}</p>
                        </div>
                        <div className="w-16 shrink-0 text-sm">
                          <p className="text-xs text-slate-400">Visitas</p>
                          <p className="font-semibold tabular-nums text-slate-900">{c.visits}</p>
                        </div>
                        <div className="flex w-36 shrink-0 flex-col items-start gap-1">
                          <SegmentBadge segment={c.segment} />
                          {c.frequentNoShow && <Badge tone="rose" className="max-w-full">Falla seguido ({c.noShows})</Badge>}
                          {c.unclosed > 0 && <Badge tone="amber">Por cerrar</Badge>}
                          {c.optedOut && <Badge tone="slate">No contactar</Badge>}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
                {list.data && list.data.items.length < list.data.total && (
                  <div className="flex justify-center">
                    <Button variant="secondary" onClick={() => setLimit((n) => n + 50)}>
                      Ver más ({list.data.total - list.data.items.length} restantes)
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        )}
        <p className="text-xs text-slate-400">
          Las estadísticas cuentan como «vino» las citas marcadas como completadas. En riesgo = más de 60 días sin venir; perdido = más de 120.
        </p>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- citas por cerrar

function ToClose({ items, loading, error, reload }: { items: Appointment[]; loading: boolean; error?: string; reload: () => Promise<void> }) {
  const panel = usePanel();
  const fmt = useMemo(() => makeFormatters(panel.timezone), [panel.timezone]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const allowed = canAct(panel.role);

  async function mark(a: Appointment, status: "done" | "no_show") {
    setBusy(a.id);
    setErr(null);
    const res = await api<{ ok: true }>(`/api/appointments/${a.id}/status`, { method: "POST", body: { status } });
    if (!res.ok) setErr(res.message);
    await reload();
    setBusy(null);
  }

  if (loading) return <div className="flex justify-center p-10 text-slate-400"><Spinner /></div>;
  if (error) return <Alert>{error}</Alert>;
  if (items.length === 0) {
    return (
      <div className="rounded-2xl bg-white py-16 ring-1 ring-slate-200">
        <EmptyState title="No hay citas por cerrar" hint="Aquí aparecen las citas que ya pasaron y siguen sin marcar. Cuando las marcas, las estadísticas de cada cliente se mantienen al día." />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-500">Marca si el cliente vino. Es lo que alimenta las visitas y los segmentos.</p>
      {err && <Alert>{err}</Alert>}
      <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
        {items.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <div className="w-32 shrink-0">
              <p className="text-sm font-medium text-slate-900">{fmt.dayLabel(a.startsAt)}</p>
              <p className="text-xs tabular-nums text-slate-400">{fmt.time(a.startsAt)}</p>
            </div>
            <div className="min-w-0 flex-1 basis-40">
              <Link href={`/clientes/${a.contact.id}`} className="truncate font-medium text-slate-900 hover:underline">{a.contact.name}</Link>
              <p className="truncate text-sm text-slate-500">{a.service.name} · {a.staff.name}</p>
            </div>
            {allowed && (
              <div className="flex gap-1.5">
                <Button className="px-3 py-1 text-xs" onClick={() => mark(a, "done")} loading={busy === a.id}>Vino</Button>
                <Button variant="secondary" className="px-3 py-1 text-xs" onClick={() => mark(a, "no_show")} disabled={busy === a.id}>No vino</Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------------- nuevo cliente

export function NewCustomerDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ displayName: "", phone: "", email: "", tags: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; details?: string[]; otherId?: string; otherName?: string } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function save() {
    setSaving(true);
    setError(null);
    const res = await api<{ ok: true; id: string }>("/api/customers", {
      method: "POST",
      body: { ...f, tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean) },
    });
    setSaving(false);
    if (res.ok) {
      onCreated();
      window.location.href = `/clientes/${res.id}`;
      return;
    }
    setError(res as NonNullable<typeof error>);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label="Nuevo cliente">
      <div className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">Nuevo cliente</h2>
        <label className="block space-y-1 text-sm font-medium text-slate-700">
          Nombre
          <input className={field} value={f.displayName} onChange={set("displayName")} autoFocus maxLength={120} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1 text-sm font-medium text-slate-700">
            Teléfono (WhatsApp)
            <input className={field} value={f.phone} onChange={set("phone")} inputMode="tel" placeholder="999 123 4567" />
          </label>
          <label className="block space-y-1 text-sm font-medium text-slate-700">
            Correo
            <input className={field} value={f.email} onChange={set("email")} inputMode="email" />
          </label>
        </div>
        <label className="block space-y-1 text-sm font-medium text-slate-700">
          Etiquetas <span className="font-normal text-slate-400">(separadas por coma)</span>
          <input className={field} value={f.tags} onChange={set("tags")} placeholder="vip, referida" />
        </label>
        <label className="block space-y-1 text-sm font-medium text-slate-700">
          Notas internas <span className="font-normal text-slate-400">(solo las ve tu equipo)</span>
          <textarea className={field} rows={2} value={f.notes} onChange={set("notes")} maxLength={2000} />
        </label>
        {error && (
          <Alert>
            <p>{error.message}</p>
            {error.details?.map((d) => <p key={d}>{d}</p>)}
            {error.otherId && <Link className="font-semibold underline" href={`/clientes/${error.otherId}`}>Ver a {error.otherName}</Link>}
          </Alert>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={save} loading={saving}>Guardar cliente</Button>
        </div>
      </div>
    </div>
  );
}
