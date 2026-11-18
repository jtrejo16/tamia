"use client";

import type { BillingBucket, OperatorClient, PlatformSummary } from "@empleado/inbox";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api, usePolling } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { Alert, Badge, Button, Spinner, cx } from "./ui";

type Client = Serialized<OperatorClient>;
type Summary = Serialized<PlatformSummary>;
interface Platform {
  worker: boolean;
  llmMode: "free" | "paid";
  publicBaseUrl: string | null;
  services: { mercadopago: boolean; retell: boolean; meta: boolean; google: boolean; openrouter: boolean };
}

// ---------------------------------------------------------------- etiquetas compartidas con la pantalla de detalle

type Tone = "slate" | "teal" | "amber" | "rose" | "sky" | "green";
export const BUCKET: Record<BillingBucket, { label: string; tone: Tone }> = {
  pending: { label: "Por aprobar", tone: "amber" },
  trial: { label: "En prueba", tone: "sky" },
  trial_ending: { label: "Prueba por terminar", tone: "amber" },
  paid: { label: "Pagando", tone: "green" },
  due_soon: { label: "Por vencer", tone: "amber" },
  overdue: { label: "Vencido", tone: "rose" },
  canceled: { label: "Canceló", tone: "slate" },
  comped: { label: "Cortesía", tone: "teal" },
  paused: { label: "Pausado", tone: "slate" },
  none: { label: "Sin suscripción", tone: "slate" },
};

export const money = (v: number) => v.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
export const dayLabel = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" }) : "—");

export function ago(iso: string | null): string {
  if (!iso) return "nunca";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "hace un momento";
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86_400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86_400)} d`;
}

/** "vence en 5 días" / "venció hace 3 días" / "hoy". */
export function whenLabel(daysLeft: number | null): string {
  if (daysLeft === null) return "";
  if (daysLeft === 0) return "hoy";
  if (daysLeft > 0) return `en ${daysLeft} día${daysLeft === 1 ? "" : "s"}`;
  return `hace ${-daysLeft} día${daysLeft === -1 ? "" : "s"}`;
}

export const HEALTH: Record<string, { label: string; dot: string }> = {
  ok: { label: "Todo bien", dot: "bg-emerald-500" },
  warn: { label: "Revisar", dot: "bg-amber-500" },
  error: { label: "Con problemas", dot: "bg-rose-500" },
  na: { label: "—", dot: "bg-slate-300" },
};

const CHANNEL_SHORT: Record<string, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram" };

// ---------------------------------------------------------------- filtros

const FILTERS: Array<{ id: string; label: string; test: (c: Client) => boolean }> = [
  { id: "all", label: "Todos", test: () => true },
  { id: "pending", label: "Por aprobar", test: (c) => c.billing.bucket === "pending" },
  { id: "problems", label: "Con problemas", test: (c) => c.health.level === "error" || c.health.level === "warn" },
  { id: "overdue", label: "Vencidos", test: (c) => c.billing.bucket === "overdue" },
  { id: "due", label: "Por vencer", test: (c) => c.billing.bucket === "due_soon" || c.billing.bucket === "trial_ending" },
  { id: "paying", label: "Pagando", test: (c) => c.billing.bucket === "paid" || c.billing.bucket === "due_soon" },
  { id: "trial", label: "En prueba", test: (c) => c.billing.bucket === "trial" || c.billing.bucket === "trial_ending" },
  { id: "nochannel", label: "Sin canal", test: (c) => c.status === "active" && !c.channels.some((ch) => ch.hasToken && ch.status === "active") },
  { id: "other", label: "Cortesía / cancelados", test: (c) => ["comped", "canceled", "paused", "none"].includes(c.billing.bucket) },
];

// ---------------------------------------------------------------- piezas

function Kpi({ label, value, hint, tone }: { label: string; value: string | number; hint?: string; tone?: "bad" | "warn" | "good" }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cx("mt-1 text-2xl font-semibold", tone === "bad" ? "text-rose-700" : tone === "warn" ? "text-amber-700" : tone === "good" ? "text-emerald-700" : "text-slate-900")}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

function Chip({ ok, children, title }: { ok: boolean; children: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800")}>
      <span className={cx("h-2 w-2 rounded-full", ok ? "bg-emerald-500" : "bg-rose-500")} />
      {children}
    </span>
  );
}

export function ChannelChips({ channels }: { channels: Client["channels"] }) {
  if (channels.length === 0) return <span className="text-xs text-rose-700">Sin canales</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {channels.map((c) => {
        const ok = c.hasToken && c.status === "active";
        return (
          <span key={c.type} title={`${CHANNEL_SHORT[c.type] ?? c.type}: ${ok ? "conectado" : c.status === "error" ? "con error" : "desconectado"}${c.quality ? ` · calidad ${c.quality}` : ""}`}
            className={cx("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium", ok ? "bg-emerald-50 text-emerald-800" : c.status === "error" ? "bg-rose-100 text-rose-800" : "bg-slate-100 text-slate-500")}>
            <span className={cx("h-1.5 w-1.5 rounded-full", ok ? "bg-emerald-500" : c.status === "error" ? "bg-rose-500" : "bg-slate-400")} />
            {CHANNEL_SHORT[c.type] ?? c.type}
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- pantalla

export function OperatorView() {
  const { data, error, loading, reload } = usePolling<{ ok: true; clients: Client[]; summary: Summary; platform: Platform }>("/api/operator", 60_000);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const clients = data?.clients;
  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter) ?? FILTERS[0]!;
    const q = query.trim().toLowerCase();
    return (clients ?? [])
      .filter(f.test)
      .filter((c) => !q || `${c.name} ${c.ownerEmail ?? ""} ${c.slug}`.toLowerCase().includes(q));
  }, [clients, filter, query]);

  async function approve(c: Client) {
    setBusy(c.id);
    setActionError(null);
    const res = await api("/api/operator/status", { method: "POST", body: { tenantId: c.id, status: "active" } });
    if (!res.ok) setActionError(res.message);
    await reload();
    setBusy(null);
  }

  if (!data) return <div className="flex justify-center p-10 text-slate-400">{error ? <Alert>{error.message}</Alert> : loading ? <Spinner /> : null}</div>;
  const s = data.summary;
  const p = data.platform;
  const counts: Record<string, number> = Object.fromEntries(FILTERS.map((f) => [f.id, data.clients.filter(f.test).length]));

  return (
    <div className="mx-auto h-full max-w-7xl space-y-4 overflow-y-auto p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Operador</h1>
          <p className="text-sm text-slate-500">Todos tus clientes: quién paga, quién está por vencer y si su servicio funciona.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/operador/costos" className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50">Costos y rentabilidad</Link>
          <Button variant="secondary" className="px-3 py-1.5" onClick={() => void reload()}>Actualizar</Button>
        </div>
      </div>

      {/* ---- estado de la plataforma */}
      <section aria-label="Estado de la plataforma" className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
        <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Plataforma</span>
        <Chip ok={p.worker} title="El servicio que envía mensajes, recordatorios y concilia cobros">{p.worker ? "Envíos funcionando" : "Envíos DETENIDOS"}</Chip>
        <Chip ok={p.llmMode === "paid"} title="Con modelos gratuitos el asistente es de pruebas">{p.llmMode === "paid" ? "IA de pago" : "IA gratuita (pruebas)"}</Chip>
        <Chip ok={p.services.mercadopago}>Mercado Pago</Chip>
        <Chip ok={p.services.meta}>Meta (Facebook/WhatsApp)</Chip>
        <Chip ok={p.services.retell}>Retell (llamadas)</Chip>
        <Chip ok={p.services.google}>Google Calendar</Chip>
        <Chip ok={p.services.openrouter}>OpenRouter (IA)</Chip>
      </section>
      {!p.worker && <Alert>El servicio de envíos no está dando señales de vida: ningún cliente recibe respuestas ni recordatorios. Revisa el servicio «worker» en Railway.</Alert>}

      {/* ---- cifras */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
        <Kpi label="Clientes" value={s.total} hint={`${s.comped} de cortesía`} />
        <Kpi label="Por aprobar" value={s.pendingApproval} tone={s.pendingApproval > 0 ? "warn" : undefined} />
        <Kpi label="Pagando" value={s.paying} tone="good" />
        <Kpi label="Ingreso mensual" value={money(s.mrrMxn)} hint="Suscripciones que pagan" tone="good" />
        <Kpi label="Renuevan en 7 días" value={money(s.renewingNext7dMxn)} hint={`${s.dueSoon} cliente(s)`} />
        <Kpi label="En prueba" value={s.trial} hint={`${s.trialEnding} terminan en ≤3 días`} />
        <Kpi label="Vencidos" value={s.overdue} tone={s.overdue > 0 ? "bad" : undefined} hint="Sin pago vigente" />
        <Kpi label="Con problemas" value={s.healthError + s.healthWarn} tone={s.healthError > 0 ? "bad" : s.healthWarn > 0 ? "warn" : "good"} hint={`${s.healthError} graves · ${s.healthWarn} a revisar`} />
        <Kpi label="Sin canal conectado" value={s.withoutChannel} tone={s.withoutChannel > 0 ? "warn" : undefined} />
        <Kpi label="Escalaciones abiertas" value={s.openHandoffs} hint="Esperan a una persona" />
      </div>

      {/* ---- filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente o correo…" aria-label="Buscar cliente"
          className="w-full rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-teal-600 sm:w-64" />
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button key={f.id} onClick={() => setFilter(f.id)} aria-pressed={filter === f.id}
              className={cx("rounded-full px-3 py-1 text-xs font-medium ring-1", filter === f.id ? "bg-teal-700 text-white ring-teal-700" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50")}>
              {f.label} <span className={filter === f.id ? "text-teal-100" : "text-slate-400"}>{counts[f.id]}</span>
            </button>
          ))}
        </div>
      </div>
      {actionError && <Alert>{actionError}</Alert>}

      {/* ---- clientes */}
      {shown.length === 0 ? (
        <p className="rounded-2xl bg-white p-8 text-center text-sm text-slate-500 ring-1 ring-slate-200">Ningún cliente coincide con este filtro.</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((c) => {
            const b = BUCKET[c.billing.bucket];
            const h = HEALTH[c.health.level] ?? HEALTH.na!;
            return (
              <li key={c.id} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)_auto] lg:items-center">
                  <div className="min-w-0">
                    <Link href={`/operador/${c.id}`} className="block truncate font-medium text-slate-900 hover:text-teal-800 hover:underline">{c.name}</Link>
                    <p className="truncate text-xs text-slate-500">{c.ownerEmail ?? "sin dueño"} · plan {c.plan} · alta {dayLabel(c.createdAt)}</p>
                  </div>
                  <div>
                    <Badge tone={b.tone}>{b.label}</Badge>
                    <p className="mt-1 text-xs text-slate-500">
                      {c.billing.bucket === "pending" ? "Esperando tu aprobación" :
                        c.billing.dueAt ? `${c.billing.bucket === "paid" || c.billing.bucket === "due_soon" ? "Próximo cobro" : c.billing.bucket === "overdue" ? "Venció" : c.billing.bucket === "canceled" ? "Acceso hasta" : "Termina"} ${dayLabel(c.billing.dueAt)} (${whenLabel(c.billing.daysLeft)})` : "—"}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm" title={c.health.issues.map((i) => i.text).join("\n")}>
                      <span className={cx("h-2.5 w-2.5 shrink-0 rounded-full", h.dot)} />
                      <span className="font-medium text-slate-800">{h.label}</span>
                    </div>
                    {c.health.issues.length > 0 && <p className="mt-1 truncate text-xs text-slate-500">{c.health.issues[0]!.text}{c.health.issues.length > 1 ? ` (+${c.health.issues.length - 1})` : ""}</p>}
                  </div>
                  <div className="space-y-1">
                    <ChannelChips channels={c.channels} />
                    <p className="text-xs text-slate-500">{c.inbound7d} msj. en 7 d · último {ago(c.lastInboundAt)}</p>
                  </div>
                  <div className="flex gap-2 lg:justify-end">
                    {c.status === "pending" && <Button className="px-3 py-1.5" loading={busy === c.id} onClick={() => approve(c)}>Aprobar</Button>}
                    <Link href={`/operador/${c.id}`} className="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium text-teal-800 ring-1 ring-teal-200 hover:bg-teal-50">Abrir</Link>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
