"use client";

import type { DayView, ReservationSettingsView, ReservationView } from "@empleado/inbox";
import { useState } from "react";
import { api, usePolling, type ApiError } from "@/lib/client";
import { canAct, usePanel } from "./panel-context";
import { Alert, Badge, Button, EmptyState, Spinner, cx } from "./ui";

type Status = ReservationView["status"];
type Settings = ReservationSettingsView["settings"];

const field = "w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-900 ring-1 ring-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600";
const CHANNEL: Record<string, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram", voice: "Llamada", panel: "Panel" };
const STATUS: Record<Status, { label: string; tone: "amber" | "sky" | "green" | "rose" | "slate" }> = {
  confirmed: { label: "Confirmada", tone: "amber" },
  seated: { label: "Sentada", tone: "sky" },
  completed: { label: "Completada", tone: "green" },
  cancelled: { label: "Cancelada", tone: "rose" },
  no_show: { label: "No llegó", tone: "slate" },
};

const timeOf = (iso: string, tz: string) => new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
const todayKey = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const shift = (key: string, days: number) => {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const longDate = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

function Row({ r, tz, canEdit, busy, onStatus }: { r: ReservationView; tz: string; canEdit: boolean; busy: boolean; onStatus: (to: Status) => void }) {
  const st = STATUS[r.status];
  const past = new Date(r.startsAt).getTime() < Date.now();
  return (
    <li className="space-y-2 rounded-xl bg-white p-3 ring-1 ring-slate-200" aria-label={`Reservación ${r.number}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">
            {timeOf(r.startsAt, tz)} · {r.customerName} · {r.partySize} {r.partySize === 1 ? "persona" : "personas"}
          </p>
          <p className="text-xs text-slate-500">
            #{r.number} · {CHANNEL[r.channel] ?? r.channel}
            {r.customerPhone ? ` · ${r.customerPhone}` : ""}
          </p>
        </div>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>
      {r.notes && <p className="rounded-lg bg-slate-50 px-2 py-1 text-xs text-slate-700">Nota: {r.notes}</p>}
      {r.status === "cancelled" && (
        <p className="text-xs text-slate-500">
          {r.cancelledBy === "cliente" ? "La canceló el cliente" : "La canceló el restaurante"}
          {r.cancelReason && r.cancelledBy !== "cliente" ? `: ${r.cancelReason}` : ""}
        </p>
      )}
      {canEdit && (r.status === "confirmed" || r.status === "seated") && (
        <div className="flex flex-wrap gap-2 pt-1">
          {r.status === "confirmed" && (
            <Button loading={busy} onClick={() => onStatus("seated")}>
              Llegó, sentar
            </Button>
          )}
          {r.status === "seated" && (
            <Button loading={busy} onClick={() => onStatus("completed")}>
              Terminó
            </Button>
          )}
          {r.status === "confirmed" && past && (
            <Button variant="secondary" disabled={busy} onClick={() => onStatus("no_show")}>
              No llegó
            </Button>
          )}
          {r.status === "confirmed" && (
            <Button variant="danger" disabled={busy} onClick={() => onStatus("cancelled")} aria-label={`Cancelar reservación ${r.number}`}>
              Cancelar
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function NewReservation({ date, onClose, onSaved }: { date: string; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: "", phone: "", date, time: "20:00", partySize: "2", notes: "" });
  const [error, setError] = useState<ApiError | null>(null);
  const [full, setFull] = useState(false);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    const r = await api<{ ok: true; overbooked: boolean }>("/api/reservations", { method: "POST", body: { ...f, partySize: Number(f.partySize), ignoreCapacity: force } });
    setBusy(false);
    if (!r.ok) {
      setFull(r.error === "sin_cupo");
      return setError(r);
    }
    onSaved();
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 p-3 sm:items-center" role="dialog" aria-modal="true" aria-label="Nueva reservación">
      <div className="max-h-[92vh] w-full max-w-md space-y-3 overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">Nueva reservación</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium text-slate-700 sm:col-span-2">
            Nombre
            <input className={cx(field, "mt-1")} value={f.name} onChange={set("name")} autoFocus />
          </label>
          <label className="block text-xs font-medium text-slate-700 sm:col-span-2">
            Teléfono
            <input className={cx(field, "mt-1")} inputMode="tel" placeholder="999 123 4567" value={f.phone} onChange={set("phone")} />
          </label>
          <label className="block text-xs font-medium text-slate-700">
            Día
            <input type="date" className={cx(field, "mt-1")} value={f.date} onChange={set("date")} />
          </label>
          <label className="block text-xs font-medium text-slate-700">
            Hora
            <input type="time" className={cx(field, "mt-1")} value={f.time} onChange={set("time")} />
          </label>
          <label className="block text-xs font-medium text-slate-700">
            Personas
            <input className={cx(field, "mt-1")} inputMode="numeric" value={f.partySize} onChange={set("partySize")} />
          </label>
          <label className="block text-xs font-medium text-slate-700 sm:col-span-2">
            Nota (opcional)
            <input className={cx(field, "mt-1")} maxLength={200} placeholder="Cumpleaños, silla para bebé…" value={f.notes} onChange={set("notes")} />
          </label>
        </div>
        {error && (
          <Alert>
            <p>{error.message}</p>
            {error.details?.map((d) => <p key={d}>{d}</p>)}
          </Alert>
        )}
        {full && (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Reservar de todos modos (pasa el aforo)
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button loading={busy} onClick={() => void save()}>Guardar</Button>
        </div>
      </div>
    </div>
  );
}

function SettingsCard({ data, canEdit, onSaved }: { data: ReservationSettingsView; canEdit: boolean; onSaved: () => void }) {
  const s: Settings = data.settings;
  const [f, setF] = useState({
    enabled: s.reservationsEnabled,
    capacity: String(s.reservationsCapacity),
    stayMinutes: String(s.reservationsStayMinutes),
    slotMinutes: String(s.reservationsSlotMinutes),
    maxParty: String(s.reservationsMaxParty),
    minNoticeMinutes: String(s.reservationsMinNoticeMinutes),
    maxDaysAhead: String(s.reservationsMaxDaysAhead),
    lastSeatingMinutes: String(s.reservationsLastSeatingMinutes),
  });
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const r = await api("/api/reservations/settings", { method: "POST", body: f });
    setBusy(false);
    if (!r.ok) return setError(r);
    setSaved(true);
    onSaved();
  }

  const num = (k: keyof typeof f, label: string, hint?: string) => (
    <label className="block text-xs font-medium text-slate-700">
      {label}
      <input className={cx(field, "mt-1")} inputMode="numeric" value={f[k] as string} disabled={!canEdit} onChange={set(k)} />
      {hint && <span className="mt-0.5 block font-normal text-slate-500">{hint}</span>}
    </label>
  );

  return (
    <section className="space-y-4 rounded-2xl bg-white p-4 ring-1 ring-slate-200" aria-label="Ajustes de reservaciones">
      <label className="flex items-start gap-3">
        <input type="checkbox" className="mt-1" checked={f.enabled} disabled={!canEdit} onChange={(e) => setF((p) => ({ ...p, enabled: e.target.checked }))} />
        <span>
          <span className="block text-sm font-semibold text-slate-900">Tomar reservaciones con el asistente</span>
          <span className="block text-xs text-slate-500">El asistente reserva mesa mientras el grupo quepa en el aforo durante todo el rato que ocuparía. Usa tu horario general.</span>
        </span>
      </label>
      {!data.hoursConfigured && <Alert tone="amber">Todavía no cargas tu horario (Ajustes → Horarios). Sin él, el asistente no puede ofrecer horas.</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        {num("capacity", "Aforo (personas a la vez)", "Cuántos comensales caben al mismo tiempo.")}
        {num("stayMinutes", "Duración de la mesa (minutos)", "Cuánto se calcula que dura una mesa.")}
        <label className="block text-xs font-medium text-slate-700">
          Ofrecer horas cada
          <select className={cx(field, "mt-1")} value={f.slotMinutes} disabled={!canEdit} onChange={set("slotMinutes")}>
            <option value="15">15 minutos</option>
            <option value="30">30 minutos</option>
            <option value="60">60 minutos</option>
          </select>
        </label>
        {num("maxParty", "Grupo máximo", "Los grupos más grandes los atiende una persona.")}
        {num("minNoticeMinutes", "Aviso mínimo (minutos)", "Cuánto antes se debe reservar.")}
        {num("maxDaysAhead", "Hasta cuántos días adelante")}
        {num("lastSeatingMinutes", "Última reservación antes del cierre (minutos)")}
      </div>
      {error && (
        <Alert>
          <p>{error.message}</p>
          {error.details?.map((d) => <p key={d}>{d}</p>)}
        </Alert>
      )}
      {saved && <Alert tone="green">Guardado.</Alert>}
      {canEdit && (
        <Button loading={busy} onClick={() => void save()}>
          Guardar ajustes
        </Button>
      )}
    </section>
  );
}

export function ReservationsView() {
  const panel = usePanel();
  const canEdit = canAct(panel.role);
  const [tab, setTab] = useState<"agenda" | "ajustes">("agenda");
  const [date, setDate] = useState<string | null>(null);
  const day = usePolling<{ ok: true } & DayView>(tab === "agenda" ? `/api/reservations${date ? `?date=${date}` : ""}` : null, 8000);
  const settings = usePolling<{ ok: true } & ReservationSettingsView>(tab === "ajustes" ? "/api/reservations/settings" : null, 30000);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState<ReservationView | null>(null);
  const [reason, setReason] = useState("");

  const tz = day.data?.timeZone ?? panel.timezone;
  const current = date ?? day.data?.date ?? todayKey(tz);
  const isToday = current === todayKey(tz);

  async function move(r: ReservationView, to: Status, why?: string) {
    setBusy(r.id);
    setNotice(null);
    const res = await api<{ ok: true; notice: string }>(`/api/reservations/${r.id}/status`, { method: "POST", body: { status: to, reason: why } });
    setBusy(null);
    if (!res.ok) setNotice(res.message);
    else if (to === "cancelled" && res.notice !== "sent") setNotice(`Reservación #${r.number}: se canceló, pero no se le pudo escribir al cliente (pasaron más de 24 h desde su último mensaje, o fue por llamada). Avísale por otro medio.`);
    await day.reload();
  }

  const list = day.data?.reservations ?? [];
  const pct = day.data && day.data.capacity > 0 ? Math.min(100, Math.round((day.data.peak / day.data.capacity) * 100)) : 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Reservaciones</h1>
            <p className="text-sm text-slate-500">Las mesas que reserva el asistente y las que anotas tú, contra el aforo del restaurante.</p>
          </div>
          {canEdit && tab === "agenda" && <Button onClick={() => setCreating(true)}>+ Nueva reservación</Button>}
        </header>

        <div role="tablist" className="flex gap-1 border-b border-slate-200">
          {(["agenda", "ajustes"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cx("px-3 py-2 text-sm font-medium", tab === t ? "border-b-2 border-teal-700 text-teal-800" : "text-slate-500 hover:text-slate-800")}>
              {t === "agenda" ? "Agenda" : "Ajustes"}
            </button>
          ))}
        </div>

        {notice && <Alert tone="amber">{notice}</Alert>}

        {tab === "agenda" && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" aria-label="Día anterior" onClick={() => setDate(shift(current, -1))}>‹</Button>
              <Button variant={isToday ? "primary" : "secondary"} onClick={() => setDate(null)}>Hoy</Button>
              <Button variant="secondary" aria-label="Día siguiente" onClick={() => setDate(shift(current, 1))}>›</Button>
              <input type="date" aria-label="Elegir día" className={cx(field, "w-auto")} value={current} onChange={(e) => e.target.value && setDate(e.target.value)} />
              <p className="text-sm font-medium text-slate-700 first-letter:uppercase">{longDate(current)}</p>
            </div>

            {day.data && !day.data.enabled && <Alert tone="amber">El asistente todavía no toma reservaciones. Actívalo en la pestaña Ajustes (puedes anotar reservaciones a mano de todos modos).</Alert>}

            {day.data && (
              <section className="space-y-2 rounded-2xl bg-white p-4 ring-1 ring-slate-200" aria-label="Resumen del día">
                <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm text-slate-700">
                  <span><span className="text-xl font-semibold text-slate-900">{day.data.count}</span> reservaciones</span>
                  <span><span className="text-xl font-semibold text-slate-900">{day.data.covers}</span> comensales</span>
                  <span>Pico: <span className="font-semibold text-slate-900">{day.data.peak}</span> de {day.data.capacity}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Ocupación máxima del día">
                  <div className={cx("h-full rounded-full", pct >= 90 ? "bg-rose-500" : pct >= 70 ? "bg-amber-500" : "bg-teal-600")} style={{ width: `${pct}%` }} />
                </div>
              </section>
            )}

            {day.loading && !day.data ? (
              <div className="flex justify-center p-10"><Spinner /></div>
            ) : list.length === 0 ? (
              <EmptyState title="Sin reservaciones este día" hint="Cuando un cliente reserve por WhatsApp, Messenger, Instagram o llamada, aparecerá aquí." />
            ) : (
              <ul className="space-y-2">
                {list.map((r) => (
                  <Row key={r.id} r={r} tz={tz} canEdit={canEdit} busy={busy === r.id} onStatus={(to) => (to === "cancelled" ? (setReason(""), setCancelling(r)) : void move(r, to))} />
                ))}
              </ul>
            )}
          </>
        )}

        {tab === "ajustes" && (settings.data ? <SettingsCard key={JSON.stringify(settings.data.settings)} data={settings.data} canEdit={canEdit} onSaved={() => void settings.reload()} /> : <div className="flex justify-center p-10"><Spinner /></div>)}
      </div>

      {creating && (
        <NewReservation
          date={current}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void day.reload();
          }}
        />
      )}

      {cancelling && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 p-3 sm:items-center" role="dialog" aria-modal="true" aria-label="Cancelar reservación">
          <div className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-slate-900">Cancelar la reservación #{cancelling.number}</h2>
            <p className="text-sm text-slate-600">Se le avisará al cliente. Escribe el motivo para que lo sepa (por ejemplo «evento privado»).</p>
            <input className={field} placeholder="Motivo (opcional)" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} autoFocus />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCancelling(null)}>Volver</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const r = cancelling;
                  setCancelling(null);
                  void move(r, "cancelled", reason);
                }}
              >
                Cancelar reservación
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
