"use client";

import type { CustomerDetail } from "@empleado/inbox";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api, makeFormatters, usePolling } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { APPOINTMENT_STATUS, ChannelBadges, ORDER_STATUS, RESERVATION_STATUS, SegmentBadge, dateFormatter, money, prettyPhone } from "./customer-ui";
import { NewAppointmentDialog } from "./new-appointment-dialog";
import { canAct, usePanel } from "./panel-context";
import { Alert, Avatar, Badge, Button, Spinner, cx } from "./ui";

type Customer = Serialized<CustomerDetail>;

const field = "w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-900 ring-1 ring-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 disabled:bg-slate-50 disabled:text-slate-500";

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {hint && <p className="text-xs text-slate-500">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div title={hint}>
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-0.5 text-base font-semibold text-slate-900">{value}</p>
    </div>
  );
}

export function CustomerDetailView({ id }: { id: string }) {
  const panel = usePanel();
  const fmt = useMemo(() => makeFormatters(panel.timezone), [panel.timezone]);
  const date = useMemo(() => dateFormatter(panel.timezone), [panel.timezone]);
  const res = usePolling<{ ok: true; customer: Customer }>(`/api/customers/${id}`, 20000);
  const [formKey, setFormKey] = useState(0);
  const [saved, setSaved] = useState(false);
  const [newAppt, setNewAppt] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const c = res.data?.customer;
  const allowed = canAct(panel.role);
  const hasCitas = panel.modules.includes("citas");
  const hasRestaurant = panel.modules.includes("restaurante");
  /** Restaurante sin agenda de citas: el resumen habla de pedidos y reservaciones. */
  const restaurant = hasRestaurant && !hasCitas;

  async function mark(apptId: string, status: "done" | "no_show") {
    setBusy(apptId);
    setError(null);
    const r = await api<{ ok: true }>(`/api/appointments/${apptId}/status`, { method: "POST", body: { status } });
    if (!r.ok) setError(r.message);
    await res.reload();
    setBusy(null);
  }

  async function markReservation(id: string, status: "completed" | "no_show") {
    setBusy(id);
    setError(null);
    const r = await api<{ ok: true }>(`/api/reservations/${id}/status`, { method: "POST", body: { status } });
    if (!r.ok) setError(r.message);
    await res.reload();
    setBusy(null);
  }

  async function merge(keepId: string, mergeId: string, name: string) {
    if (!window.confirm(`¿Unir a "${c?.name}" con "${name}"?\n\nSe juntan sus conversaciones, ${restaurant ? "pedidos, reservaciones" : "citas"} y llamadas en un solo cliente. No se puede deshacer.`)) return;
    setBusy(mergeId);
    setError(null);
    const r = await api<{ ok: true; keptId: string }>("/api/contacts/merge", { method: "POST", body: { keepId, mergeId } });
    setBusy(null);
    if (!r.ok) return setError(r.message);
    window.location.href = `/clientes/${r.keptId}`;
  }

  if (res.loading && !res.data) return <div className="flex h-full justify-center p-10 text-slate-400"><Spinner /></div>;
  if (!c) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 p-6">
        <Link href="/clientes" className="text-sm text-teal-800 underline">← Clientes</Link>
        <Alert>{res.error?.message ?? "No se encontró al cliente."}</Alert>
      </div>
    );
  }
  const s = c.stats;

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 p-4 lg:p-6">
        <Link href="/clientes" className="text-sm text-teal-800 underline">← Clientes</Link>

        <div className="flex flex-wrap items-center gap-4">
          <Avatar name={c.name} className="h-14 w-14 text-xl" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-semibold text-slate-900">{c.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <SegmentBadge segment={c.segment} restaurant={restaurant} />
              <ChannelBadges channels={c.channels} />
              {c.frequentNoShow && <Badge tone="rose">{restaurant ? "No llega seguido" : "Falla seguido"} ({s.noShows})</Badge>}
              {c.optedOut && <Badge tone="slate">No contactar</Badge>}
              <span className="text-xs text-slate-400">Cliente desde {date(c.createdAt)}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {allowed && hasCitas && <Button onClick={() => setNewAppt(true)}>Agendar cita</Button>}
            {hasRestaurant && (
              <Link href="/reservaciones" className="inline-flex items-center rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50">
                Reservaciones
              </Link>
            )}
            {c.conversations[0] && (
              <Link href={`/bandeja?c=${c.conversations[0].id}`} className="inline-flex items-center rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50">
                Abrir conversación
              </Link>
            )}
          </div>
        </div>
        {newAppt && <NewAppointmentDialog contact={{ id: c.id, name: c.name }} onClose={() => setNewAppt(false)} onCreated={() => void res.reload()} />}
        {error && <Alert>{error}</Alert>}

        {restaurant ? (
          <Card title="Resumen" hint="Cuenta como visita cada pedido entregado y cada reservación completada.">
            <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
              <Fact label="Pedidos" value={s.orders} hint="Pedidos entregados." />
              <Fact label="Gastado" value={s.spendCents > 0 ? money(s.spendCents, s.currency) : "—"} hint="Suma de sus pedidos entregados." />
              <Fact label="Ticket promedio" value={s.avgTicketCents !== null ? money(s.avgTicketCents, s.currency) : "—"} hint="Lo que gasta en promedio por pedido entregado." />
              <Fact label="Reservaciones" value={s.reservationsDone} hint="Reservaciones completadas." />
              <Fact label="¿Ha vuelto?" value={s.returned ? "Sí" : s.visits === 1 ? "Aún no" : "—"} hint="Ha vuelto cuando tiene 2 o más visitas (pedidos entregados o reservaciones completadas)." />
              <Fact label="No llegó" value={s.noShows} hint="Reservaciones en las que no llegó." />
              <Fact label="Canceló" value={s.cancelled} hint="Pedidos y reservaciones cancelados." />
              <Fact label="En curso" value={s.upcoming > 0 ? `${s.upcoming}` : "Nada"} hint="Pedidos en curso y reservaciones próximas." />
              <Fact label="Primera visita" value={date(s.firstVisitAt)} />
              <Fact label="Última visita" value={s.lastVisitAt ? `${date(s.lastVisitAt)}` : "—"} hint={s.daysSinceLastVisit !== null ? `Hace ${s.daysSinceLastVisit} días` : undefined} />
              <Fact label="Viene cada" value={s.avgDaysBetweenVisits !== null ? `~${s.avgDaysBetweenVisits} días` : "—"} hint="Promedio entre sus visitas. Necesita 2 o más." />
              <Fact label="Platillo favorito" value={s.topDish ? `${s.topDish.name} (${s.topDish.count})` : "—"} hint="El que más ha pedido en pedidos entregados." />
            </div>
            {s.daysSinceLastVisit !== null && (c.segment === "en_riesgo" || c.segment === "perdido") && (
              <Alert tone="amber">Hace {s.daysSinceLastVisit} días que no pide ni viene y no tiene nada en curso. Puede ser buen momento para escribirle.</Alert>
            )}
            {s.unclosed > 0 && <Alert tone="amber">Tiene {s.unclosed} {s.unclosed === 1 ? "reservación pasada" : "reservaciones pasadas"} sin cerrar: marca abajo si vino.</Alert>}
          </Card>
        ) : (
        <Card title="Resumen" hint="Cuenta como «vino» cada cita marcada como completada.">
          <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
            <Fact label="Visitas" value={s.visits} />
            <Fact label="¿Ha vuelto?" value={s.returned ? "Sí" : s.visits === 1 ? "Aún no" : "—"} hint="Ha vuelto cuando tiene 2 o más visitas." />
            <Fact label="No vino" value={s.noShows} />
            <Fact label="Canceló" value={s.cancelled} />
            <Fact label="Primera visita" value={date(s.firstVisitAt)} />
            <Fact label="Última visita" value={s.lastVisitAt ? `${date(s.lastVisitAt)}` : "—"} hint={s.daysSinceLastVisit !== null ? `Hace ${s.daysSinceLastVisit} días` : undefined} />
            <Fact label="Viene cada" value={s.avgDaysBetweenVisits !== null ? `~${s.avgDaysBetweenVisits} días` : "—"} hint="Promedio entre sus visitas realizadas. Necesita 2 o más." />
            <Fact label="Cita próxima" value={s.upcoming > 0 ? `${s.upcoming}` : "Ninguna"} />
            <Fact label="Servicio más frecuente" value={s.topService ? `${s.topService.name} (${s.topService.count})` : "—"} />
            <Fact label="Gasto estimado" value={s.estimatedSpendCents > 0 ? money(s.estimatedSpendCents, s.currency) : "—"} hint="Suma de los precios actuales de sus citas realizadas. Es una aproximación, no un cobro registrado." />
          </div>
          {s.daysSinceLastVisit !== null && c.segment !== "recurrente" && (c.segment === "en_riesgo" || c.segment === "perdido") && (
            <Alert tone="amber">Hace {s.daysSinceLastVisit} días que no viene y no tiene cita próxima. Puede ser buen momento para escribirle.</Alert>
          )}
          {s.unclosed > 0 && <Alert tone="amber">Tiene {s.unclosed} {s.unclosed === 1 ? "cita pasada" : "citas pasadas"} sin cerrar: marca abajo si vino.</Alert>}
        </Card>
        )}

        <div className="grid gap-4 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <EditForm key={formKey} customer={c} editable={allowed} saved={saved} onDirty={() => setSaved(false)} onSaved={async () => { await res.reload(); setFormKey((k) => k + 1); setSaved(true); }} onMerge={merge} />
          </div>

          <div className="space-y-4 lg:col-span-3">
            {hasRestaurant && (
              <Card title="Historial de pedidos" hint={c.orders.length === 0 ? undefined : `${s.orders} entregados · ${c.orders.length >= 50 ? "se muestran los 50 más recientes" : `${c.orders.length} en total`}`}>
                {c.orders.length === 0 ? (
                  <p className="text-sm text-slate-500">Todavía no ha hecho pedidos.</p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {c.orders.map((o) => {
                      const st = ORDER_STATUS[o.status] ?? { text: o.status, tone: "slate" as const };
                      return (
                        <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
                          <div className="w-28 shrink-0">
                            <p className="text-sm font-medium text-slate-900">{date(o.createdAt)}</p>
                            <p className="text-xs tabular-nums text-slate-400">{fmt.time(o.createdAt)}</p>
                          </div>
                          <div className="min-w-0 flex-1 basis-40">
                            <p className="truncate text-sm text-slate-800">#{o.number} · {o.items || "—"}</p>
                            <p className="truncate text-xs text-slate-500">{o.mode === "delivery" ? "A domicilio" : "Para recoger"} · {money(o.totalCents, s.currency)}</p>
                          </div>
                          <Badge tone={st.tone}>{st.text}</Badge>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            )}

            {hasRestaurant && (
              <Card title="Historial de reservaciones" hint={c.reservations.length === 0 ? undefined : `${c.reservations.length >= 50 ? "se muestran las 50 más recientes" : `${c.reservations.length} en total`}`}>
                {c.reservations.length === 0 ? (
                  <p className="text-sm text-slate-500">Todavía no ha hecho reservaciones.</p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {c.reservations.map((r) => {
                      const st = RESERVATION_STATUS[r.status] ?? { text: r.status, tone: "slate" as const };
                      return (
                        <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
                          <div className="w-28 shrink-0">
                            <p className="text-sm font-medium text-slate-900">{date(r.startsAt)}</p>
                            <p className="text-xs tabular-nums text-slate-400">{fmt.time(r.startsAt)}</p>
                          </div>
                          <div className="min-w-0 flex-1 basis-32">
                            <p className="truncate text-sm text-slate-800">#{r.number} · {r.partySize} {r.partySize === 1 ? "persona" : "personas"}</p>
                            {r.notes && <p className="truncate text-xs text-slate-500">{r.notes}</p>}
                          </div>
                          <Badge tone={r.needsClosing ? "amber" : st.tone}>{r.needsClosing ? "Por cerrar" : st.text}</Badge>
                          {r.needsClosing && allowed && (
                            <div className="flex gap-1.5">
                              <Button className="px-2.5 py-1 text-xs" onClick={() => markReservation(r.id, "completed")} loading={busy === r.id}>Vino</Button>
                              {r.status === "confirmed" && <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => markReservation(r.id, "no_show")} disabled={busy === r.id}>No vino</Button>}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            )}

            {hasCitas && (
            <Card title="Historial de citas" hint={c.appointments.length === 0 ? undefined : `${c.appointments.length} en total`}>
              {c.appointments.length === 0 ? (
                <p className="text-sm text-slate-500">Todavía no tiene citas.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {c.appointments.map((a) => {
                    const st = APPOINTMENT_STATUS[a.status] ?? { text: a.status, tone: "slate" as const };
                    return (
                      <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
                        <div className="w-28 shrink-0">
                          <p className="text-sm font-medium text-slate-900">{date(a.startsAt)}</p>
                          <p className="text-xs tabular-nums text-slate-400">{fmt.time(a.startsAt)}</p>
                        </div>
                        <div className="min-w-0 flex-1 basis-32">
                          <p className="truncate text-sm text-slate-800">{a.service}</p>
                          <p className="truncate text-xs text-slate-500">{a.staff}{a.priceCents ? ` · ${money(a.priceCents, s.currency)}` : ""}</p>
                        </div>
                        <Badge tone={a.needsClosing ? "amber" : st.tone}>{a.needsClosing ? "Por cerrar" : st.text}</Badge>
                        {a.needsClosing && allowed && (
                          <div className="flex gap-1.5">
                            <Button className="px-2.5 py-1 text-xs" onClick={() => mark(a.id, "done")} loading={busy === a.id}>Vino</Button>
                            <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => mark(a.id, "no_show")} disabled={busy === a.id}>No vino</Button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
            )}

            {c.possibleSame.length > 0 && (
              <Card title="¿Es la misma persona?" hint="Por su nombre o teléfono, parece haber escrito también por otro medio.">
                <ul className="space-y-2">
                  {c.possibleSame.map((p) => (
                    <li key={p.contactId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
                      <div className="min-w-0">
                        <Link href={`/clientes/${p.contactId}`} className="truncate text-sm font-medium text-slate-900 hover:underline">{p.name}</Link>
                        <p className="text-xs text-slate-500">{prettyPhone(p.phone)} · {p.reason === "name" ? "mismo nombre" : "mismo teléfono"}</p>
                      </div>
                      {allowed && (
                        <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => merge(c.id, p.contactId, p.name)} loading={busy === p.contactId}>Unir con este cliente</Button>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- datos editables

function EditForm({
  customer: c,
  editable,
  saved,
  onDirty,
  onSaved,
  onMerge,
}: {
  customer: Customer;
  editable: boolean;
  /** «Guardado ✓»: vive en el padre porque el formulario se vuelve a armar con los datos ya normalizados. */
  saved: boolean;
  onDirty: () => void;
  onSaved: () => Promise<void>;
  onMerge: (keepId: string, mergeId: string, name: string) => Promise<void>;
}) {
  const panel = usePanel();
  const restaurant = panel.modules.includes("restaurante") && !panel.modules.includes("citas");
  const [f, setF] = useState({
    displayName: c.displayName ?? "",
    phone: c.phone ?? "",
    email: c.email ?? "",
    tags: c.tags.join(", "),
    notes: c.notes,
    optedOut: c.optedOut,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; details?: string[]; otherId?: string; otherName?: string } | null>(null);
  const set = (k: "displayName" | "phone" | "email" | "tags" | "notes") => (e: { target: { value: string } }) => {
    onDirty();
    setF((p) => ({ ...p, [k]: e.target.value }));
  };

  async function save() {
    setSaving(true);
    setError(null);
    onDirty();
    const r = await api<{ ok: true }>(`/api/customers/${c.id}`, {
      method: "POST",
      body: { ...f, tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean) },
    });
    setSaving(false);
    if (r.ok) {
      await onSaved();
      return;
    }
    setError(r as NonNullable<typeof error>);
  }

  return (
    <Card title="Datos del cliente" hint={editable ? "Si cambias el teléfono, sus mensajes nuevos seguirán llegando a este cliente." : "Tu rol solo permite ver."}>
      <label className="block space-y-1 text-sm font-medium text-slate-700">
        Nombre
        <input className={field} value={f.displayName} onChange={set("displayName")} disabled={!editable} maxLength={120} placeholder={c.name} />
      </label>
      <label className="block space-y-1 text-sm font-medium text-slate-700">
        Teléfono (WhatsApp)
        <input className={field} value={f.phone} onChange={set("phone")} disabled={!editable} inputMode="tel" placeholder="999 123 4567" />
      </label>
      {c.otherPhones.length > 0 && <p className="text-xs text-slate-500">Otros números anotados: {c.otherPhones.map((p) => prettyPhone(p)).join(", ")}</p>}
      <label className="block space-y-1 text-sm font-medium text-slate-700">
        Correo
        <input className={field} value={f.email} onChange={set("email")} disabled={!editable} inputMode="email" />
      </label>
      <label className="block space-y-1 text-sm font-medium text-slate-700">
        Etiquetas <span className="font-normal text-slate-400">(separadas por coma)</span>
        <input className={field} value={f.tags} onChange={set("tags")} disabled={!editable} placeholder={restaurant ? "vip, cumpleañero" : "vip, ortodoncia"} />
      </label>
      <label className="block space-y-1 text-sm font-medium text-slate-700">
        Notas internas <span className="font-normal text-slate-400">(solo las ve tu equipo; el asistente no las lee)</span>
        <textarea className={field} rows={4} value={f.notes} onChange={set("notes")} disabled={!editable} maxLength={2000} />
      </label>
      <label className={cx("flex items-start gap-2 text-sm text-slate-700", !editable && "opacity-60")}>
        <input type="checkbox" className="mt-0.5 h-4 w-4 rounded accent-teal-700" checked={f.optedOut} disabled={!editable} onChange={(e) => { onDirty(); setF((p) => ({ ...p, optedOut: e.target.checked })); }} />
        <span>
          No contactar
          <span className="block text-xs text-slate-400">Pidió no recibir recordatorios ni solicitudes de reseña.</span>
        </span>
      </label>

      {error && (
        <Alert>
          <p>{error.message}</p>
          {error.details?.map((d) => <p key={d}>{d}</p>)}
          {error.otherId && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Link className="font-semibold underline" href={`/clientes/${error.otherId}`}>Ver a {error.otherName}</Link>
              {editable && (
                <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => onMerge(error.otherId!, c.id, error.otherName ?? "ese cliente")}>
                  Son la misma persona: unirlos
                </Button>
              )}
            </div>
          )}
        </Alert>
      )}
      {saved && <Alert tone="green">Guardado ✓</Alert>}
      {editable && <Button onClick={save} loading={saving}>Guardar cambios</Button>}
    </Card>
  );
}
