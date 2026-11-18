"use client";

import type { BookingCatalog, BookingContact } from "@empleado/inbox";
import { useEffect, useMemo, useState } from "react";
import { api, makeFormatters } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { usePanel } from "./panel-context";
import { Alert, Button, Spinner, cx } from "./ui";

type Catalog = Serialized<BookingCatalog>;
type Slot = { startIso: string; staffId: string; staffName: string };

const field = "w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-900 ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-teal-600";

/**
 * "Nueva cita": una persona del equipo agenda por el cliente. Los horarios son los REALMENTE libres
 * (los mismos que usa el asistente), así que no se puede empalmar ni agendar fuera de horario.
 */
export function NewAppointmentDialog({
  contact,
  conversationId,
  canNotify,
  onClose,
  onCreated,
}: {
  /** Cliente ya elegido (desde una conversación). Si falta, se busca. */
  contact?: { id: string; name: string };
  conversationId?: string;
  /** Se puede avisar al cliente en la conversación (tienes el control y la ventana de 24 h está abierta). */
  canNotify?: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const panel = usePanel();
  const fmt = useMemo(() => makeFormatters(panel.timezone), [panel.timezone]);

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(contact ?? null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<BookingContact[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [staffId, setStaffId] = useState("");
  const [day, setDay] = useState(() => fmt.dayKey(new Date()));
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [notify, setNotify] = useState(Boolean(canNotify));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ summary: string; notified: boolean | string } | null>(null);

  const service = catalog?.services.find((s) => s.id === serviceId) ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    void api<{ ok: true } & Catalog>("/api/appointments/booking?what=catalog").then((r) => {
      if (!live) return;
      if (!r.ok) return setCatalogError(r.message);
      setCatalog(r);
      if (r.services.length === 1) setServiceId(r.services[0]!.id);
    });
    return () => {
      live = false;
    };
  }, []);

  // Buscar cliente (solo si no viene elegido).
  useEffect(() => {
    if (picked || query.trim().length < 2) return setMatches([]);
    let live = true;
    const t = setTimeout(() => {
      void api<{ ok: true; items: BookingContact[] }>(`/api/appointments/booking?what=contacts&q=${encodeURIComponent(query.trim())}`).then((r) => {
        if (live && r.ok) setMatches(r.items);
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, picked]);

  // Horarios libres del día elegido.
  useEffect(() => {
    setSlot(null);
    setSlots(null);
    setSlotsError(null);
    if (!serviceId || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    let live = true;
    const qs = new URLSearchParams({ what: "slots", serviceId, day, ...(staffId ? { staffId } : {}) });
    void api<{ ok: true; slots: Slot[] }>(`/api/appointments/booking?${qs}`).then((r) => {
      if (!live) return;
      if (!r.ok) return setSlotsError(r.message);
      setSlots(r.slots);
    });
    return () => {
      live = false;
    };
  }, [serviceId, staffId, day]);

  function shiftDay(delta: number) {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    setDay(d.toISOString().slice(0, 10));
  }

  async function submit() {
    if (!picked || !service || !slot) return;
    setSaving(true);
    setError(null);
    const r = await api<{ ok: true; summary: string; notified: boolean | string }>("/api/appointments", {
      method: "POST",
      body: { contactId: picked.id, serviceId, staffId: slot.staffId, startIso: slot.startIso, ...(conversationId ? { conversationId } : {}), notify: notify && Boolean(conversationId) },
    });
    setSaving(false);
    if (!r.ok) {
      setError(r.message);
      // Si alguien tomó el horario justo antes, se refresca la lista.
      if (r.error === "horario_no_disponible") setDay((d) => d);
      return;
    }
    setDone({ summary: r.summary, notified: r.notified });
    onCreated();
  }

  const multipleStaff = (service?.staff.length ?? 0) > 1;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Nueva cita" className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-base font-semibold text-slate-900">Nueva cita</h2>
          <button onClick={onClose} aria-label="Cerrar" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">✕</button>
        </div>

        <div className="space-y-4 overflow-y-auto px-4 py-4">
          {done ? (
            <div className="space-y-3">
              <Alert tone="green">Cita agendada y confirmada.</Alert>
              <p className="text-sm text-slate-700">{done.summary}</p>
              <p className="text-xs text-slate-500">
                {done.notified === true
                  ? "Ya le escribimos al cliente en la conversación."
                  : conversationId && notify
                    ? "No se pudo avisar al cliente en la conversación (necesitas tener el control y que la ventana de 24 h esté abierta). Avísale tú."
                    : "No se le avisó al cliente: escríbele tú para confirmarle."}
              </p>
              <Button onClick={onClose}>Listo</Button>
            </div>
          ) : catalogError ? (
            <Alert>{catalogError}</Alert>
          ) : !catalog ? (
            <div className="flex justify-center p-8 text-slate-400"><Spinner /></div>
          ) : catalog.services.length === 0 ? (
            <Alert tone="amber">Primero carga tus servicios y quién los atiende en Ajustes → Servicios.</Alert>
          ) : (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Cliente</label>
                {picked ? (
                  <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-200">
                    <span className="font-medium text-slate-900">{picked.name}</span>
                    {!contact && <button onClick={() => setPicked(null)} className="text-xs text-teal-800 underline">Cambiar</button>}
                  </div>
                ) : (
                  <div>
                    <input className={field} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Busca por nombre o teléfono…" autoFocus />
                    {matches.length > 0 && (
                      <ul className="mt-1 overflow-hidden rounded-lg ring-1 ring-slate-200">
                        {matches.map((m) => (
                          <li key={m.id}>
                            <button onClick={() => setPicked({ id: m.id, name: m.name })} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50">
                              <span className="text-slate-900">{m.name}</span>
                              <span className="text-xs text-slate-400">{m.phone ?? ""}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {query.trim().length >= 2 && matches.length === 0 && <p className="mt-1 text-xs text-slate-400">Sin resultados. El cliente debe haber escrito o llamado antes.</p>}
                  </div>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Servicio</label>
                  <select className={field} value={serviceId} onChange={(e) => { setServiceId(e.target.value); setStaffId(""); }}>
                    <option value="">Elige…</option>
                    {catalog.services.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.durationMin} min)</option>)}
                  </select>
                </div>
                {multipleStaff && (
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600">Con quién</label>
                    <select className={field} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                      <option value="">Cualquiera</option>
                      {service!.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                )}
              </div>
              {service && service.staff.length === 0 && <Alert tone="amber">Nadie atiende este servicio todavía: asígnalo en Ajustes → Equipo.</Alert>}

              {service && service.staff.length > 0 && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Día</label>
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" className="px-2.5 py-1.5" onClick={() => shiftDay(-1)} aria-label="Día anterior">←</Button>
                    <input type="date" className={cx(field, "flex-1")} value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
                    <Button variant="secondary" className="px-2.5 py-1.5" onClick={() => shiftDay(1)} aria-label="Día siguiente">→</Button>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{fmt.dayLabel(`${day}T12:00:00Z`)}</p>

                  <div className="mt-2">
                    {slotsError ? (
                      <Alert>{slotsError}</Alert>
                    ) : !slots ? (
                      <div className="p-3 text-slate-400"><Spinner /></div>
                    ) : slots.length === 0 ? (
                      <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-500">No hay horarios libres ese día. Prueba otro día.</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5" role="listbox" aria-label="Horarios libres">
                        {slots.map((s) => {
                          const active = slot?.startIso === s.startIso && slot.staffId === s.staffId;
                          return (
                            <button key={s.startIso + s.staffId} role="option" aria-selected={active} onClick={() => setSlot(s)}
                              className={cx("rounded-lg px-2.5 py-1.5 text-sm tabular-nums ring-1", active ? "bg-teal-700 text-white ring-teal-700" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50")}>
                              {fmt.time(s.startIso)}
                              {multipleStaff && !staffId && <span className={cx("ml-1 text-[11px]", active ? "text-teal-100" : "text-slate-400")}>{s.staffName.split(" ")[0]}</span>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {conversationId && (
                <label className={cx("flex items-start gap-2 text-sm", canNotify ? "text-slate-700" : "text-slate-400")}>
                  <input type="checkbox" className="mt-0.5 h-4 w-4 rounded accent-teal-700" checked={notify && Boolean(canNotify)} disabled={!canNotify} onChange={(e) => setNotify(e.target.checked)} />
                  <span>
                    Avisarle al cliente en esta conversación
                    {!canNotify && <span className="block text-xs">Disponible cuando tienes el control y la ventana de 24 h está abierta.</span>}
                  </span>
                </label>
              )}

              {error && <Alert>{error}</Alert>}
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="secondary" onClick={onClose}>Cancelar</Button>
                <Button onClick={submit} loading={saving} disabled={!picked || !service || !slot}>
                  {slot ? `Agendar ${fmt.time(slot.startIso)}` : "Agendar"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
