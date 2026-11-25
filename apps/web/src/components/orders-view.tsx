"use client";

import type { OrderView } from "@empleado/inbox";
import { useEffect, useRef, useState } from "react";
import { api, usePolling, type ApiError } from "@/lib/client";
import { canAct, usePanel } from "./panel-context";
import { Alert, Badge, Button, EmptyState, Spinner, cx } from "./ui";

type Status = OrderView["status"];

interface Settings {
  acceptingOrders: boolean;
  prepMinutes: number;
  minOrderCents: number;
  paymentMethods: string[];
  transferInfo: string | null;
  deliveryEnabled: boolean;
  deliveryMinutes: number;
  freeDeliveryFromCents: number | null;
}

interface Zone {
  id: string;
  name: string;
  feeCents: number;
  minOrderCents: number;
  active: boolean;
}

const field = "w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-900 ring-1 ring-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600";
const pesos = (cents: number) => (cents / 100).toLocaleString("es-MX", { style: "currency", currency: "MXN", minimumFractionDigits: cents % 100 === 0 ? 0 : 2 });
const toPesosText = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
const CHANNEL: Record<string, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram", voice: "Llamada", panel: "Panel" };
const PAY: Record<string, string> = { efectivo: "Efectivo", tarjeta: "Tarjeta", transferencia: "Transferencia" };
const COLUMNS: Array<{ status: Status; title: string; tone: string }> = [
  { status: "new", title: "Nuevos", tone: "ring-amber-300 bg-amber-50/60" },
  { status: "preparing", title: "Preparando", tone: "ring-sky-300 bg-sky-50/60" },
  { status: "ready", title: "Listos", tone: "ring-green-300 bg-green-50/60" },
  { status: "on_the_way", title: "En camino", tone: "ring-violet-300 bg-violet-50/60" },
];
/** El siguiente paso de un pedido: los de domicilio pasan por «en camino». */
function nextStep(o: OrderView): { to: Status; label: string } | null {
  const delivery = o.mode === "delivery";
  switch (o.status) {
    case "new":
      return { to: "preparing", label: "Empezar a preparar" };
    case "preparing":
      return { to: "ready", label: delivery ? "Listo para enviar" : "Marcar listo" };
    case "ready":
      return delivery ? { to: "on_the_way", label: "Salió a entregar" } : { to: "delivered", label: "Marcar entregado" };
    case "on_the_way":
      return { to: "delivered", label: "Marcar entregado" };
    default:
      return null;
  }
}

/** Un pitido corto con Web Audio (sin archivos). Falla en silencio si el navegador lo bloquea. */
function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    osc.onended = () => void ctx.close();
  } catch {
    /* sin sonido */
  }
}

function OrderCard({ order, canEdit, busy, onMove, onCancel }: { order: OrderView; canEdit: boolean; busy: boolean; onMove: (to: Status) => void; onCancel: () => void }) {
  const next = nextStep(order);
  return (
    <article className="space-y-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200" aria-label={`Pedido ${order.number}`}>
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">
            #{order.number} · {order.customerName}
          </p>
          <p className="text-xs text-slate-500">
            {hhmm(order.createdAt)} · {CHANNEL[order.channel] ?? order.channel}
            {order.customerPhone ? ` · ${order.customerPhone}` : ""}
          </p>
        </div>
        <p className="shrink-0 text-sm font-semibold text-slate-900">{pesos(order.totalCents)}</p>
      </header>
      <ul className="space-y-1 text-sm text-slate-800">
        {order.lines.map((l) => (
          <li key={l.id}>
            <span className="font-medium">{l.quantity} ×</span> {l.name}
            {l.modifiers.length > 0 && <span className="text-slate-500"> ({l.modifiers.map((m) => m.optionName).join(", ")})</span>}
            {l.notes && <span className="block text-xs font-medium text-amber-700">⚠ {l.notes}</span>}
          </li>
        ))}
      </ul>
      {order.notes && <p className="rounded-lg bg-slate-50 px-2 py-1 text-xs text-slate-700">Nota: {order.notes}</p>}
      {order.mode === "delivery" && (
        <p className="rounded-lg bg-violet-50 px-2 py-1 text-xs text-violet-900">
          <span className="font-semibold">Entregar en:</span> {order.deliveryAddress}
          {order.deliveryZoneName ? `, col. ${order.deliveryZoneName}` : ""} · envío {order.deliveryFeeCents > 0 ? pesos(order.deliveryFeeCents) : "gratis"}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge tone={order.mode === "delivery" ? "sky" : "teal"}>{order.mode === "delivery" ? "A domicilio" : "Para recoger"}</Badge>
        <Badge tone="slate">{PAY[order.paymentMethod] ?? order.paymentMethod}</Badge>
        {order.estimatedReadyAt && (order.status === "new" || order.status === "preparing") && <Badge tone="sky">Prometido {hhmm(order.estimatedReadyAt)}</Badge>}
        {order.status === "cancelled" && <Badge tone="rose">{order.cancelledBy === "cliente" ? "Lo canceló el cliente" : "Cancelado"}</Badge>}
        {order.status === "delivered" && <Badge tone="green">Entregado</Badge>}
      </div>
      {order.status === "cancelled" && order.cancelReason && <p className="text-xs text-slate-500">{order.cancelReason}</p>}
      {canEdit && next && (
        <div className="flex gap-2 pt-1">
          <Button className="flex-1" loading={busy} onClick={() => onMove(next.to)}>
            {next.label}
          </Button>
          <Button variant="danger" disabled={busy} onClick={onCancel} aria-label={`Cancelar pedido ${order.number}`}>
            Cancelar
          </Button>
        </div>
      )}
    </article>
  );
}

function SettingsCard({ settings, zones: initialZones, canEdit, onSaved }: { settings: Settings; zones: Zone[]; canEdit: boolean; onSaved: () => void }) {
  const [form, setForm] = useState({
    acceptingOrders: settings.acceptingOrders,
    prepMinutes: String(settings.prepMinutes),
    minOrderPesos: String(settings.minOrderCents / 100),
    paymentMethods: settings.paymentMethods,
    transferInfo: settings.transferInfo ?? "",
    deliveryEnabled: settings.deliveryEnabled,
    deliveryMinutes: String(settings.deliveryMinutes),
    freeDeliveryFromPesos: settings.freeDeliveryFromCents ? toPesosText(settings.freeDeliveryFromCents) : "",
  });
  const [zones, setZones] = useState(initialZones.map((z) => ({ id: z.id as string | undefined, name: z.name, feePesos: toPesosText(z.feeCents), minOrderPesos: z.minOrderCents ? toPesosText(z.minOrderCents) : "", active: z.active })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(patch: Partial<typeof form> = {}) {
    const next = { ...form, ...patch };
    setForm(next);
    setSaving(true);
    setError(null);
    setSaved(false);
    const r = await api("/api/orders/settings", { method: "POST", body: { ...next, prepMinutes: Number(next.prepMinutes), deliveryMinutes: Number(next.deliveryMinutes), minOrderPesos: Number(next.minOrderPesos || 0), zones: zones.filter((z) => z.name.trim() || z.id) } });
    setSaving(false);
    if (!r.ok) return setError(r);
    setSaved(true);
    onSaved();
  }
  const toggle = (m: string) => setForm((f) => ({ ...f, paymentMethods: f.paymentMethods.includes(m) ? f.paymentMethods.filter((x) => x !== m) : [...f.paymentMethods, m] }));

  return (
    <section className="space-y-4 rounded-2xl bg-white p-4 ring-1 ring-slate-200" aria-label="Ajustes de pedidos">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Recibir pedidos</h2>
          <p className="text-xs text-slate-500">Si la cocina está saturada, pausa los pedidos: el asistente avisará al cliente y no tomará nuevos.</p>
        </div>
        <button
          role="switch"
          aria-checked={form.acceptingOrders}
          aria-label="Recibir pedidos"
          disabled={!canEdit || saving}
          onClick={() => void save({ acceptingOrders: !form.acceptingOrders })}
          className={cx("relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50", form.acceptingOrders ? "bg-teal-600" : "bg-slate-300")}
        >
          <span className={cx("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", form.acceptingOrders ? "left-[22px]" : "left-0.5")} />
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-slate-700">
          Tiempo de preparación (minutos)
          <input className={cx(field, "mt-1")} inputMode="numeric" value={form.prepMinutes} disabled={!canEdit} onChange={(e) => setForm({ ...form, prepMinutes: e.target.value })} />
        </label>
        <label className="block text-xs font-medium text-slate-700">
          Pedido mínimo (pesos, 0 = sin mínimo)
          <input className={cx(field, "mt-1")} inputMode="decimal" value={form.minOrderPesos} disabled={!canEdit} onChange={(e) => setForm({ ...form, minOrderPesos: e.target.value })} />
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-slate-700">Formas de pago al recoger</legend>
        <div className="flex flex-wrap gap-3 text-sm">
          {Object.entries(PAY).map(([k, label]) => (
            <label key={k} className="flex items-center gap-1.5">
              <input type="checkbox" checked={form.paymentMethods.includes(k)} disabled={!canEdit} onChange={() => toggle(k)} /> {label}
            </label>
          ))}
        </div>
        {form.paymentMethods.includes("transferencia") && (
          <label className="block text-xs font-medium text-slate-700">
            Datos para transferir (CLABE y titular)
            <input className={cx(field, "mt-1")} value={form.transferInfo} disabled={!canEdit} onChange={(e) => setForm({ ...form, transferInfo: e.target.value })} />
          </label>
        )}
      </fieldset>
      <fieldset className="space-y-3 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
        <legend className="px-1 text-sm font-semibold text-slate-900">Entrega a domicilio</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.deliveryEnabled} disabled={!canEdit} onChange={(e) => setForm({ ...form, deliveryEnabled: e.target.checked })} />
          Ofrecer entrega a domicilio (solo a las zonas de abajo)
        </label>
        {form.deliveryEnabled && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-medium text-slate-700">
                Tiempo de entrega (minutos)
                <input className={cx(field, "mt-1")} inputMode="numeric" value={form.deliveryMinutes} disabled={!canEdit} onChange={(e) => setForm({ ...form, deliveryMinutes: e.target.value })} />
              </label>
              <label className="block text-xs font-medium text-slate-700">
                Envío gratis desde (pesos, vacío = nunca)
                <input className={cx(field, "mt-1")} inputMode="decimal" value={form.freeDeliveryFromPesos} disabled={!canEdit} onChange={(e) => setForm({ ...form, freeDeliveryFromPesos: e.target.value })} />
              </label>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-700">Zonas de entrega (colonias) y costo de envío</p>
              {zones.map((z, i) => (
                <div key={z.id ?? `n${i}`} className="grid grid-cols-[1fr_88px_88px_auto_auto] items-center gap-2">
                  <input className={field} aria-label={`Zona ${i + 1}`} placeholder="Colonia o zona" value={z.name} disabled={!canEdit} onChange={(e) => setZones((zs) => zs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  <input className={field} aria-label={`Envío de la zona ${i + 1}`} placeholder="Envío $" inputMode="decimal" value={z.feePesos} disabled={!canEdit} onChange={(e) => setZones((zs) => zs.map((x, j) => (j === i ? { ...x, feePesos: e.target.value } : x)))} />
                  <input className={field} aria-label={`Mínimo de la zona ${i + 1}`} placeholder="Mín. $" inputMode="decimal" value={z.minOrderPesos} disabled={!canEdit} onChange={(e) => setZones((zs) => zs.map((x, j) => (j === i ? { ...x, minOrderPesos: e.target.value } : x)))} />
                  <label className="flex items-center gap-1 text-xs text-slate-600">
                    <input type="checkbox" checked={z.active} disabled={!canEdit} onChange={(e) => setZones((zs) => zs.map((x, j) => (j === i ? { ...x, active: e.target.checked } : x)))} /> Activa
                  </label>
                  {canEdit && (
                    <button className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100" aria-label={`Quitar zona ${i + 1}`} onClick={() => setZones((zs) => zs.filter((_, j) => j !== i))}>✕</button>
                  )}
                </div>
              ))}
              {canEdit && (
                <Button variant="secondary" onClick={() => setZones((zs) => [...zs, { id: undefined, name: "", feePesos: "", minOrderPesos: "", active: true }])}>
                  + Agregar zona
                </Button>
              )}
              <p className="text-xs text-slate-500">El asistente solo entrega en estas zonas y cobra el envío que pongas aquí. «Mín.» es el pedido mínimo de esa zona (vacío = el general).</p>
            </div>
          </>
        )}
      </fieldset>
      {error && (
        <Alert>
          <p>{error.message}</p>
          {error.details?.map((d) => <p key={d}>{d}</p>)}
        </Alert>
      )}
      {saved && <Alert tone="green">Guardado.</Alert>}
      {canEdit && (
        <Button loading={saving} onClick={() => void save()}>
          Guardar ajustes
        </Button>
      )}
    </section>
  );
}

export function OrdersView() {
  const panel = usePanel();
  const canEdit = canAct(panel.role);
  const [tab, setTab] = useState<"tablero" | "historial" | "ajustes">("tablero");
  const active = usePolling<{ ok: true; orders: OrderView[] }>(tab === "tablero" ? "/api/orders?scope=active" : null, 5000);
  const history = usePolling<{ ok: true; orders: OrderView[] }>(tab === "historial" ? "/api/orders?scope=history" : null, 15000);
  const settings = usePolling<{ ok: true; settings: Settings; zones: Zone[] }>(tab === "ajustes" || tab === "tablero" ? "/api/orders/settings" : null, 30000);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<OrderView | null>(null);
  const [reason, setReason] = useState("");
  const [sound, setSound] = useState(false);
  const seen = useRef<Set<string> | null>(null);

  // Sonido al llegar un pedido nuevo (se activa con un clic: los navegadores no dejan sonar sin que la persona interactue).
  useEffect(() => {
    try {
      setSound(localStorage.getItem("orders-sound") === "1");
    } catch {
      /* sin almacenamiento */
    }
  }, []);
  useEffect(() => {
    const list = active.data?.orders;
    if (!list) return;
    const ids = new Set(list.filter((o) => o.status === "new").map((o) => o.id));
    if (seen.current && sound && [...ids].some((id) => !seen.current!.has(id))) beep();
    seen.current = ids;
  }, [active.data, sound]);

  function toggleSound() {
    const next = !sound;
    setSound(next);
    try {
      localStorage.setItem("orders-sound", next ? "1" : "0");
    } catch {
      /* sin almacenamiento */
    }
    if (next) beep();
  }

  async function move(order: OrderView, to: Status, why?: string) {
    setBusy(order.id);
    setNotice(null);
    const r = await api<{ ok: true; notice: string }>(`/api/orders/${order.id}/status`, { method: "POST", body: { status: to, reason: why } });
    setBusy(null);
    if (!r.ok) setNotice(r.message);
    else if ((to === "ready" || to === "cancelled") && r.notice === "window_closed") setNotice(`Pedido #${order.number}: se guardó, pero no se pudo avisar al cliente por WhatsApp (pasaron más de 24 h desde su último mensaje). Avísale por otro medio.`);
    else if ((to === "ready" || to === "cancelled") && r.notice !== "sent") setNotice(`Pedido #${order.number}: se guardó, pero no se le pudo escribir al cliente. Avísale por otro medio.`);
    await active.reload();
  }

  const orders = active.data?.orders ?? [];
  const paused = settings.data?.settings.acceptingOrders === false;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Pedidos</h1>
            <p className="text-sm text-slate-500">Pedidos que toma el asistente, para recoger o a domicilio. Cambia su estado y el cliente recibe el aviso.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={toggleSound} aria-pressed={sound}>
              {sound ? "🔔 Sonido activado" : "🔕 Activar sonido"}
            </Button>
          </div>
        </header>

        <div role="tablist" className="flex gap-1 border-b border-slate-200">
          {(["tablero", "historial", "ajustes"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cx("px-3 py-2 text-sm font-medium capitalize", tab === t ? "border-b-2 border-teal-700 text-teal-800" : "text-slate-500 hover:text-slate-800")}>
              {t === "tablero" ? "Tablero" : t === "historial" ? "Historial" : "Ajustes"}
            </button>
          ))}
        </div>

        {paused && tab !== "ajustes" && <Alert tone="amber">Los pedidos están pausados: el asistente no tomará pedidos nuevos. Reactívalos en Ajustes.</Alert>}
        {notice && <Alert tone="amber">{notice}</Alert>}

        {tab === "tablero" &&
          (active.loading && !active.data ? (
            <div className="flex justify-center p-10"><Spinner /></div>
          ) : orders.length === 0 ? (
            <EmptyState title="No hay pedidos en curso" hint="Cuando un cliente pida por WhatsApp, Messenger o Instagram, aparecerá aquí al instante." />
          ) : (
            <div className={cx("grid gap-4", orders.some((o) => o.mode === "delivery") ? "lg:grid-cols-4" : "lg:grid-cols-3")}>
              {COLUMNS.filter((c) => c.status !== "on_the_way" || orders.some((o) => o.mode === "delivery")).map((col) => {
                const list = orders.filter((o) => o.status === col.status);
                return (
                  <section key={col.status} className={cx("space-y-3 rounded-2xl p-3 ring-1", col.tone)} aria-label={col.title}>
                    <h2 className="flex items-center justify-between text-sm font-semibold text-slate-800">
                      {col.title}
                      <span className="rounded-full bg-white px-2 py-0.5 text-xs ring-1 ring-slate-200">{list.length}</span>
                    </h2>
                    {list.map((o) => (
                      <OrderCard key={o.id} order={o} canEdit={canEdit} busy={busy === o.id} onMove={(to) => void move(o, to)} onCancel={() => { setReason(""); setCancelling(o); }} />
                    ))}
                  </section>
                );
              })}
            </div>
          ))}

        {tab === "historial" &&
          (history.loading && !history.data ? (
            <div className="flex justify-center p-10"><Spinner /></div>
          ) : (history.data?.orders ?? []).length === 0 ? (
            <EmptyState title="Sin pedidos cerrados" hint="Aquí verás los entregados y cancelados de los últimos 7 días." />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {history.data!.orders.map((o) => (
                <OrderCard key={o.id} order={o} canEdit={false} busy={false} onMove={() => {}} onCancel={() => {}} />
              ))}
            </div>
          ))}

        {tab === "ajustes" && (settings.data ? <SettingsCard key={JSON.stringify([settings.data.settings, settings.data.zones])} settings={settings.data.settings} zones={settings.data.zones} canEdit={canEdit} onSaved={() => void settings.reload()} /> : <div className="flex justify-center p-10"><Spinner /></div>)}
      </div>

      {cancelling && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 p-3 sm:items-center" role="dialog" aria-modal="true" aria-label="Cancelar pedido">
          <div className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-slate-900">Cancelar el pedido #{cancelling.number}</h2>
            <p className="text-sm text-slate-600">Se le avisará al cliente. Escribe el motivo para que lo sepa (por ejemplo «se acabó el pastor»).</p>
            <input className={field} placeholder="Motivo (opcional)" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} autoFocus />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCancelling(null)}>Volver</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const o = cancelling;
                  setCancelling(null);
                  void move(o, "cancelled", reason);
                }}
              >
                Cancelar pedido
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

