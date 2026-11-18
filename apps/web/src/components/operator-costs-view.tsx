"use client";

import type { ClientCost, CostPeriod, CostReport } from "@empleado/inbox";
import Link from "next/link";
import { useMemo, useState } from "react";
import { usePolling } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { BUCKET } from "./operator-view";
import { Alert, Badge, Spinner, cx } from "./ui";

type Report = Serialized<CostReport>;
type Row = Serialized<ClientCost>;

const PERIODS: Array<{ id: CostPeriod; label: string }> = [
  { id: "month", label: "Este mes" },
  { id: "last_month", label: "Mes pasado" },
  { id: "30d", label: "30 días" },
  { id: "7d", label: "7 días" },
];

const usd = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: v !== 0 && Math.abs(v) < 10 ? 2 : 0, maximumFractionDigits: 2 });

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "bad" | "good" }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cx("mt-1 text-2xl font-semibold", tone === "bad" ? "text-rose-700" : tone === "good" ? "text-emerald-700" : "text-slate-900")}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

export function OperatorCostsView() {
  const [period, setPeriod] = useState<CostPeriod>("month");
  const { data, error, loading, reload } = usePolling<{ ok: true; report: Report }>(`/api/operator/costs?period=${period}`, 120_000);
  const [sort, setSort] = useState<"cost" | "margin">("cost");

  const rows = useMemo(() => {
    const list = [...(data?.report.clients ?? [])];
    return sort === "cost" ? list.sort((a, b) => b.cost.totalUsd - a.cost.totalUsd) : list.sort((a, b) => a.marginUsd - b.marginUsd);
  }, [data, sort]);

  if (!data) return <div className="flex justify-center p-10 text-slate-400">{error ? <Alert>{error.message}</Alert> : loading ? <Spinner /> : null}</div>;
  const r = data.report;
  const t = r.totals;
  const fx = r.config.usdMxn;
  const mxn = (v: number) => (v * fx).toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
  const parts = [
    { label: "IA (OpenRouter)", v: t.aiUsd, note: "real" },
    { label: "Llamadas (Retell)", v: t.voiceUsd, note: "real; estimado si Retell no lo reportó" },
    { label: "Telefonía (troncal)", v: t.phoneUsd, note: "estimado por minuto" },
    { label: "WhatsApp (Meta)", v: t.whatsappUsd, note: "estimado por plantilla enviada" },
    { label: "Costos fijos", v: t.fixedUsd, note: r.fixed.length ? r.fixed.map((f) => f.name).join(", ") : "sin configurar" },
  ];
  const max = Math.max(...parts.map((p) => p.v), 0.0001);

  return (
    <div className="mx-auto h-full max-w-7xl space-y-4 overflow-y-auto p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <Link href="/operador" className="text-xs text-teal-800 hover:underline">← Operador</Link>
          <h1 className="text-lg font-semibold text-slate-900">Costos y rentabilidad</h1>
          <p className="text-sm text-slate-500">Cuánto cuesta atender a cada cliente y a toda la plataforma ({r.period.label.toLowerCase()}). Tipo de cambio ${fx} MXN por USD.</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PERIODS.map((p) => (
            <button key={p.id} onClick={() => setPeriod(p.id)} aria-pressed={period === p.id}
              className={cx("rounded-full px-3 py-1 text-xs font-medium ring-1", period === p.id ? "bg-teal-700 text-white ring-teal-700" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50")}>
              {p.label}
            </button>
          ))}
          <button onClick={() => void reload()} className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">Actualizar</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Ingreso del periodo" value={mxn(t.revenueUsd)} hint="Suscripciones que pagan, prorrateado" tone="good" />
        <Kpi label="Costo total" value={mxn(t.totalUsd)} hint={`${usd(t.totalUsd)} · variable ${usd(t.variableUsd)} + fijo ${usd(t.fixedUsd)}`} />
        <Kpi label="Ganancia" value={mxn(t.profitUsd)} hint="Ingreso − costos" tone={t.profitUsd < 0 ? "bad" : "good"} />
        <Kpi label="Parte estimada" value={usd(t.estimatedUsd)} hint="No medida: depende de las tarifas configuradas" />
      </div>

      <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200" aria-label="En qué se va el dinero">
        <h2 className="mb-3 text-sm font-semibold text-slate-800">¿En qué se va el dinero?</h2>
        <ul className="space-y-2">
          {parts.map((p) => (
            <li key={p.label} className="grid grid-cols-[9.5rem_1fr_6rem] items-center gap-3 text-sm sm:grid-cols-[12rem_1fr_7rem]">
              <span className="truncate text-slate-700" title={p.note}>{p.label}</span>
              <div className="h-2.5 rounded-full bg-slate-100"><div className="h-2.5 rounded-full bg-teal-600" style={{ width: `${Math.max(2, (p.v / max) * 100)}%` }} /></div>
              <span className="text-right tabular-nums text-slate-900">{usd(p.v)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-slate-500">{Math.round(t.callMinutes)} min de llamadas · {t.tplSent} plantillas de WhatsApp enviadas (las respuestas dentro de 24 h no las cobra Meta).</p>
      </section>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-800">Por cliente</h2>
        <div className="flex gap-1.5 text-xs">
          <button onClick={() => setSort("cost")} aria-pressed={sort === "cost"} className={cx("rounded-full px-3 py-1 ring-1", sort === "cost" ? "bg-teal-700 text-white ring-teal-700" : "bg-white text-slate-600 ring-slate-200")}>Más caros primero</button>
          <button onClick={() => setSort("margin")} aria-pressed={sort === "margin"} className={cx("rounded-full px-3 py-1 ring-1", sort === "margin" ? "bg-teal-700 text-white ring-teal-700" : "bg-white text-slate-600 ring-slate-200")}>Menor margen primero</button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Cliente</th>
              <th className="px-3 py-2 text-right font-medium">IA</th>
              <th className="px-3 py-2 text-right font-medium">Llamadas</th>
              <th className="px-3 py-2 text-right font-medium">Telefonía</th>
              <th className="px-3 py-2 text-right font-medium">WhatsApp</th>
              <th className="px-3 py-2 text-right font-medium">Costo</th>
              <th className="px-3 py-2 text-right font-medium">Ingreso</th>
              <th className="px-3 py-2 text-right font-medium">Margen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((c: Row) => (
              <tr key={c.tenantId} className="align-top">
                <td className="px-3 py-2">
                  <Link href={`/operador/${c.tenantId}`} className="font-medium text-slate-900 hover:text-teal-800 hover:underline">{c.name}</Link>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500"><Badge tone={BUCKET[c.bucket].tone}>{BUCKET[c.bucket].label}</Badge> plan {c.plan}</div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums" title={`${c.usage.aiTokensIn + c.usage.aiTokensOut} tokens`}>{usd(c.cost.aiUsd)}</td>
                <td className="px-3 py-2 text-right tabular-nums" title={`${c.usage.callCount} llamadas`}>{usd(c.cost.voiceUsd)}</td>
                <td className="px-3 py-2 text-right tabular-nums" title={`${Math.round(c.usage.callSeconds / 60)} min`}>{usd(c.cost.phoneUsd)}</td>
                <td className="px-3 py-2 text-right tabular-nums" title={`${c.usage.tplMarketing} marketing · ${c.usage.tplUtility + c.usage.tplUnknown} utilidad · ${c.usage.tplAuthentication} autenticación`}>{usd(c.cost.whatsappUsd)}</td>
                <td className="px-3 py-2 text-right font-medium tabular-nums text-slate-900">{usd(c.cost.totalUsd)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{c.revenueUsd > 0 ? usd(c.revenueUsd) : "—"}</td>
                <td className={cx("px-3 py-2 text-right font-medium tabular-nums", c.marginUsd < 0 ? "text-rose-700" : "text-emerald-700")}>{usd(c.marginUsd)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-500">Aún no hay clientes.</td></tr>}
          </tbody>
        </table>
      </div>

      <section className="rounded-2xl bg-amber-50 p-4 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
        <p className="font-semibold">Qué es real y qué es estimado</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          <li><b>IA</b>: costo real que reporta OpenRouter por cada respuesta.</li>
          <li><b>Llamadas</b>: costo real que reporta Retell al terminar cada llamada (solo las llamadas nuevas lo traen; las anteriores se estiman a ${r.config.rates.retellFallbackPerMinute}/min).</li>
          <li><b>Telefonía</b>: estimada a ${r.config.rates.phonePerMinute}/min. <b>WhatsApp</b>: estimado por plantilla enviada (marketing ${r.config.rates.whatsapp.marketing} · utilidad ${r.config.rates.whatsapp.utility} · autenticación ${r.config.rates.whatsapp.authentication}). Ajusta con la variable <code>COST_RATES</code> según tu factura.</li>
          <li><b>Costos fijos</b> (Railway, número telefónico, dominio…): defínelos con <code>COST_FIXED_MONTHLY_USD</code>, p. ej. <code>{`{"Railway":20,"Número DIDWW":3}`}</code>. Hoy: {r.fixed.length ? r.fixed.map((f) => f.name).join(", ") : "ninguno configurado"}.</li>
          <li>El ingreso es el precio de lista de los que pagan (sin comisión de Mercado Pago ni IVA).</li>
        </ul>
      </section>
    </div>
  );
}
