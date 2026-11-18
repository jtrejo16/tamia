"use client";

import type { StatsView as Stats } from "@empleado/inbox";
import { useState, type ReactNode } from "react";
import { usePolling } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { Alert, Spinner, cx } from "./ui";

type S = Serialized<Stats>;

const RANGES = [
  { days: 7, label: "7 días" },
  { days: 30, label: "30 días" },
  { days: 90, label: "90 días" },
];

// ---------------------------------------------------------------- formato

const int = (v: number) => v.toLocaleString("es-MX");
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const money = (v: number) => v.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
const usd = (v: number) => `US$ ${v.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function duration(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}
const minutes = (m: number | null) => (m === null ? "—" : duration(m * 60));

const WEEKDAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // semana de lunes a domingo
const CHANNELS: Record<string, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram" };

// ---------------------------------------------------------------- piezas

function Card({ title, hint, children, className }: { title: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200", className)}>
      <h2 className="font-semibold text-slate-900">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Variacion contra el periodo anterior. `goodWhenDown`: en escalaciones, bajar es bueno. */
function DeltaPill({ value, previous, goodWhenDown }: { value: number; previous: number; goodWhenDown?: boolean }) {
  if (previous === 0 && value === 0) return <span className="text-xs text-slate-400">sin cambio</span>;
  if (previous === 0) return <span className="text-xs text-slate-500">nuevo</span>;
  const change = ((value - previous) / previous) * 100;
  if (Math.abs(change) < 1) return <span className="text-xs text-slate-400">igual que antes</span>;
  const up = change > 0;
  const good = goodWhenDown ? !up : up;
  return (
    <span className={cx("text-xs font-medium", good ? "text-emerald-700" : "text-rose-700")}>
      {up ? "▲" : "▼"} {Math.abs(Math.round(change))}% <span className="font-normal text-slate-400">vs. periodo anterior</span>
    </span>
  );
}

function Kpi({ label, value, delta, goodWhenDown }: { label: string; value: number; delta: { value: number; previous: number }; goodWhenDown?: boolean }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-3xl font-semibold text-slate-900">{int(value)}</p>
      <div className="mt-1"><DeltaPill value={delta.value} previous={delta.previous} goodWhenDown={goodWhenDown} /></div>
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: "good" | "bad" }) {
  return (
    <div title={hint}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={cx("text-xl font-semibold", tone === "bad" ? "text-rose-700" : tone === "good" ? "text-emerald-700" : "text-slate-900")}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] leading-tight text-slate-400">{hint}</p>}
    </div>
  );
}

/** Barra horizontal con porcentaje (de 0 a 1). */
function RateBar({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-slate-700">{label}</span>
        <span className="font-semibold text-slate-900">{pct(value)}</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-teal-600" style={{ width: `${Math.round((value ?? 0) * 100)}%` }} />
      </div>
      {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

/** Lista de barras horizontales (nombre + cuenta). */
function HBars({ items, empty = "Sin datos en este periodo.", format = int }: { items: Array<{ name: string; count: number }>; empty?: string; format?: (v: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  if (items.length === 0) return <p className="text-sm text-slate-400">{empty}</p>;
  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li key={i.name}>
          <div className="flex justify-between text-sm"><span className="truncate text-slate-700">{i.name}</span><span className="font-medium text-slate-900">{format(i.count)}</span></div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-teal-600" style={{ width: `${(i.count / max) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

/** Columnas simples: una por categoria (horas o dias de la semana). */
function Columns({ values, labels, highlightMax = true }: { values: number[]; labels: string[]; highlightMax?: boolean }) {
  const max = Math.max(1, ...values);
  const peak = values.indexOf(Math.max(...values));
  const empty = values.every((v) => v === 0);
  return (
    <div>
      <div className="flex h-28 items-end gap-[3px]" role="img" aria-label="Distribución">
        {values.map((v, i) => (
          <div key={i} className="group relative flex h-full flex-1 items-end" title={`${labels[i]}: ${int(v)}`}>
            <div className={cx("w-full rounded-t", !empty && highlightMax && i === peak ? "bg-teal-700" : "bg-teal-300")} style={{ height: `${Math.max(v > 0 ? 4 : 0, (v / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[3px] text-[10px] text-slate-400">
        {labels.map((l, i) => (
          <span key={i} className="flex-1 truncate text-center">{values.length > 12 && i % 3 !== 0 ? "" : l}</span>
        ))}
      </div>
    </div>
  );
}

/** Mensajes por dia, apilados: cliente / asistente / persona. */
function DailyChart({ daily }: { daily: S["messages"]["daily"] }) {
  const max = Math.max(1, ...daily.map((d) => d.inbound + d.bot + d.human));
  const step = Math.max(1, Math.ceil(daily.length / 8));
  return (
    <div>
      <div className="flex h-40 items-end gap-[2px]" role="img" aria-label="Mensajes por día">
        {daily.map((d) => {
          const total = d.inbound + d.bot + d.human;
          const h = (v: number) => `${(v / max) * 100}%`;
          return (
            <div key={d.day} className="flex h-full flex-1 flex-col justify-end" title={`${d.day}: ${d.inbound} del cliente, ${d.bot} del asistente, ${d.human} de personas`}>
              {total > 0 && (
                <>
                  <div className="bg-amber-400" style={{ height: h(d.human) }} />
                  <div className="bg-teal-600" style={{ height: h(d.bot) }} />
                  <div className="rounded-t bg-slate-300" style={{ height: h(d.inbound) }} />
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-[2px] text-[10px] text-slate-400">
        {daily.map((d, i) => (
          <span key={d.day} className="flex-1 overflow-visible whitespace-nowrap text-center">{i % step === 0 ? d.day.slice(5).replace("-", "/") : ""}</span>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-500">
        <Legend color="bg-slate-300" label="Clientes" />
        <Legend color="bg-teal-600" label="Asistente" />
        <Legend color="bg-amber-400" label="Personas del equipo" />
      </div>
    </div>
  );
}
const Legend = ({ color, label }: { color: string; label: string }) => (
  <span className="inline-flex items-center gap-1.5"><span className={cx("h-2.5 w-2.5 rounded-sm", color)} />{label}</span>
);

/** Barra apilada con segmentos con nombre. */
function Stacked({ parts }: { parts: Array<{ label: string; value: number; color: string }> }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (total === 0) return <p className="text-sm text-slate-400">Sin datos en este periodo.</p>;
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
        {parts.map((p) => p.value > 0 && <div key={p.label} className={p.color} style={{ width: `${(p.value / total) * 100}%` }} title={`${p.label}: ${p.value}`} />)}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
        {parts.map((p) => <span key={p.label} className="inline-flex items-center gap-1.5"><span className={cx("h-2.5 w-2.5 rounded-sm", p.color)} />{p.label}: <strong>{int(p.value)}</strong></span>)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- pagina

/** `tenantId`: el operador ve las estadisticas de un cliente. `embedded`: dentro de otra pantalla (sin su propio scroll). */
export function StatsView({ tenantId, embedded }: { tenantId?: string; embedded?: boolean } = {}) {
  const [days, setDays] = useState(30);
  const { data, error, loading } = usePolling<{ ok: true; stats: S }>(`/api/stats?days=${days}${tenantId ? `&tenant=${tenantId}` : ""}`, 60_000);
  const s = data?.stats;
  // Al cambiar de rango se muestra el anterior mientras llega el nuevo (sin parpadeo).
  const stale = s && s.range.days !== days;

  return (
    <div className={cx("mx-auto max-w-6xl space-y-4", !embedded && "h-full overflow-y-auto p-4 sm:p-6")}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Estadísticas</h1>
          <p className="text-sm text-slate-500">
            {s ? `Del ${new Date(s.range.from).toLocaleDateString("es-MX", { timeZone: s.range.timezone, day: "numeric", month: "short" })} al ${new Date(s.range.to).toLocaleDateString("es-MX", { timeZone: s.range.timezone, day: "numeric", month: "short" })} · horario de ${s.range.timezone.replace("_", " ")}` : "Cómo está trabajando tu asistente."}
          </p>
        </div>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1" role="group" aria-label="Periodo">
          {RANGES.map((r) => (
            <button key={r.days} onClick={() => setDays(r.days)} aria-pressed={days === r.days}
              className={cx("rounded-md px-3 py-1.5 text-sm font-medium", days === r.days ? "bg-white text-teal-800 shadow-sm" : "text-slate-600 hover:text-slate-900")}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && !s && <Alert>{error.message}</Alert>}
      {!s && loading && <div className="flex justify-center p-16 text-slate-400"><Spinner /></div>}

      {s && (
        <div className={cx("space-y-4 transition-opacity", stale && "opacity-60")}>
          {s.headline.inbound.value === 0 && s.appointments.created === 0 && s.calls.total === 0 && (
            <Alert tone="sky">Todavía no hay actividad en este periodo. Cuando lleguen mensajes, citas o llamadas, aquí verás los números.</Alert>
          )}

          {/* ---- cifras clave */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <Kpi label="Mensajes de clientes" value={s.headline.inbound.value} delta={s.headline.inbound} />
            <Kpi label="Respuestas del asistente" value={s.headline.botReplies.value} delta={s.headline.botReplies} />
            <Kpi label="Respuestas de personas" value={s.headline.humanReplies.value} delta={s.headline.humanReplies} />
            <Kpi label="Conversaciones activas" value={s.headline.activeConversations.value} delta={s.headline.activeConversations} />
            <Kpi label="Citas agendadas" value={s.headline.appointmentsCreated.value} delta={s.headline.appointmentsCreated} />
            <Kpi label="Escalaciones a una persona" value={s.headline.handoffs.value} delta={s.headline.handoffs} goodWhenDown />
          </div>

          {/* ---- mensajes */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Mensajes por día" className="lg:col-span-2" hint="Solo chats (WhatsApp, Messenger, Instagram). Las llamadas se miden abajo.">
              <DailyChart daily={s.messages.daily} />
            </Card>
            <Card title="Cuándo escriben tus clientes" hint="Mensajes entrantes por hora del día y por día de la semana.">
              <p className="mb-1 text-xs font-medium text-slate-500">Por hora</p>
              <Columns values={s.messages.byHour} labels={s.messages.byHour.map((_, h) => `${h}h`)} />
              <p className="mb-1 mt-4 text-xs font-medium text-slate-500">Por día</p>
              <Columns values={WEEK_ORDER.map((d) => s.messages.byWeekday[d] ?? 0)} labels={WEEK_ORDER.map((d) => WEEKDAYS[d]!)} />
            </Card>
          </div>

          {/* ---- atencion */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Velocidad de respuesta" hint="Tiempo desde que el cliente escribe hasta la primera respuesta (asistente o persona).">
              <div className="grid grid-cols-2 gap-4">
                <Stat label="Tiempo típico" value={duration(s.response.medianSeconds)} hint="La mitad se contesta en menos que esto." />
                <Stat label="Casos lentos (90%)" value={duration(s.response.p90Seconds)} hint="9 de cada 10 se contestan antes." />
                <Stat label="Sin respuesta" value={int(s.response.unanswered)} tone={s.response.unanswered > 0 ? "bad" : "good"} hint="Clientes que escribieron y nadie contestó." />
                <Stat label="Medidos" value={int(s.response.measured)} />
              </div>
            </Card>
            <Card title="Resolución del asistente" hint="Conversaciones del periodo.">
              <div className="space-y-3">
                <RateBar label="Resueltas solo por el asistente" value={s.conversations.resolvedRate} hint="Sin que una persona interviniera ni se escalara." />
                <RateBar label="Escaladas a una persona" value={s.conversations.handoffRate} />
                <div className="grid grid-cols-2 gap-4 pt-1">
                  <Stat label="Conversaciones activas" value={int(s.conversations.active)} />
                  <Stat label="Nuevas conversaciones" value={int(s.conversations.created)} />
                  <Stat label="Urgentes" value={int(s.conversations.urgentHandoffs)} tone={s.conversations.urgentHandoffs > 0 ? "bad" : undefined} />
                  <Stat label="Pendientes ahora" value={int(s.conversations.openHandoffs)} tone={s.conversations.openHandoffs > 0 ? "bad" : "good"} hint="Escalaciones sin resolver." />
                </div>
                <Stat label="Tiempo típico para resolver una escalación" value={minutes(s.conversations.medianHandoffResolutionMinutes)} />
              </div>
            </Card>
            <Card title="Entrega de mensajes" hint="De lo que el asistente y tu equipo enviaron.">
              <div className="space-y-3">
                <RateBar label="Entregados" value={s.messages.deliveryRate} />
                <RateBar label="Leídos" value={s.messages.readRate} hint="WhatsApp solo informa lectura si el cliente la tiene activada." />
                <div className="grid grid-cols-2 gap-4 pt-1">
                  <Stat label="Enviados" value={int(s.messages.outbound)} />
                  <Stat label="Fallidos" value={int(s.messages.failed)} tone={s.messages.failed > 0 ? "bad" : "good"} />
                  <Stat label="Plantillas" value={int(s.messages.templates)} hint="Recordatorios y avisos fuera de las 24 h." />
                </div>
              </div>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Canales" hint="Mensajes por canal.">
              {s.messages.byChannel.length === 0 ? (
                <p className="text-sm text-slate-400">Sin mensajes en este periodo.</p>
              ) : (
                <ul className="space-y-3">
                  {s.messages.byChannel.map((c) => (
                    <li key={c.channel} className="flex items-center justify-between text-sm">
                      <span className="font-medium text-slate-800">{CHANNELS[c.channel] ?? c.channel}</span>
                      <span className="text-slate-600">{int(c.inbound)} recibidos · {int(c.outbound)} enviados</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Borradores del asistente" hint="Cuando el asistente propone y una persona aprueba (modo copiloto / semi).">
              {s.approvals.total === 0 ? (
                <p className="text-sm text-slate-400">No hubo borradores en este periodo.</p>
              ) : (
                <div className="space-y-3">
                  <RateBar label="Aprobados tal cual" value={s.approvals.approvedAsIsRate} hint="Entre más alto, mejor acierta el asistente." />
                  <Stacked parts={[
                    { label: "Aprobados", value: s.approvals.approved, color: "bg-teal-600" },
                    { label: "Editados", value: s.approvals.edited, color: "bg-amber-400" },
                    { label: "Descartados", value: s.approvals.discarded, color: "bg-rose-400" },
                    { label: "Pendientes", value: s.approvals.pending, color: "bg-slate-300" },
                  ]} />
                </div>
              )}
            </Card>
            <Card title="Motivos recientes de escalación">
              {s.conversations.recentReasons.length === 0 ? (
                <p className="text-sm text-slate-400">No hubo escalaciones en este periodo. 🎉</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {s.conversations.recentReasons.map((r, i) => (
                    <li key={i} className="rounded-lg bg-slate-50 p-2">
                      <p className="text-slate-800">{r.reason}</p>
                      <p className="mt-0.5 text-[11px] text-slate-400">{r.urgency === "alta" ? "Urgente · " : ""}{new Date(r.at).toLocaleDateString("es-MX", { timeZone: s.range.timezone, day: "numeric", month: "short" })}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* ---- citas */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Citas agendadas" className="lg:col-span-2" hint="Citas creadas en el periodo.">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Agendadas" value={int(s.appointments.created)} />
                <Stat label="Por el asistente" value={int(s.appointments.byAssistant)} hint={s.appointments.assistantShare === null ? undefined : `${pct(s.appointments.assistantShare)} del total`} />
                <Stat label="Por tu equipo" value={int(s.appointments.manual)} />
                <Stat label="Anticipación típica" value={s.appointments.avgLeadDays === null ? "—" : `${s.appointments.avgLeadDays.toFixed(1)} días`} hint="Entre agendar y la cita." />
              </div>
              <div className="mt-5">
                <p className="mb-2 text-xs font-medium text-slate-500">Resultado de las citas con fecha en el periodo</p>
                <Stacked parts={[
                  { label: "Realizadas", value: s.appointments.outcomes.done, color: "bg-teal-600" },
                  { label: "Confirmadas", value: s.appointments.outcomes.confirmed, color: "bg-sky-500" },
                  { label: "Por confirmar", value: s.appointments.outcomes.pending, color: "bg-slate-300" },
                  { label: "No asistieron", value: s.appointments.outcomes.noShow, color: "bg-rose-500" },
                  { label: "Canceladas", value: s.appointments.outcomes.cancelled, color: "bg-amber-400" },
                ]} />
              </div>
              <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Tasa de cancelación" value={pct(s.appointments.cancelRate)} />
                <Stat label="No asistencia" value={pct(s.appointments.noShowRate)} tone={s.appointments.noShowRate !== null && s.appointments.noShowRate > 0.15 ? "bad" : undefined} hint="No asistieron / ya cerradas." />
                <Stat label="Próximos 7 días" value={int(s.appointments.upcoming7d)} />
                <Stat label="Sin confirmar (7 días)" value={int(s.appointments.upcomingUnconfirmed7d)} tone={s.appointments.upcomingUnconfirmed7d > 0 ? "bad" : "good"} />
              </div>
            </Card>
            <Card title="Ingreso estimado" hint="Citas confirmadas o realizadas, al precio de lista de cada servicio. No es facturación.">
              <p className="text-3xl font-semibold text-slate-900">{money(s.appointments.estimatedRevenue)}</p>
              <p className="mt-4 mb-2 text-xs font-medium text-slate-500">Servicios más agendados</p>
              <HBars items={s.appointments.topServices} />
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Citas por día de la semana" hint="Por la fecha de la cita (sin canceladas).">
              <Columns values={WEEK_ORDER.map((d) => s.appointments.byWeekday[d] ?? 0)} labels={WEEK_ORDER.map((d) => WEEKDAYS[d]!)} />
            </Card>
            <Card title="Citas por hora" hint="Horas con más citas: sirve para ajustar horarios del equipo.">
              <Columns values={s.appointments.byHour} labels={s.appointments.byHour.map((_, h) => `${h}h`)} />
            </Card>
          </div>

          {/* ---- seguimiento */}
          <Card title="Seguimiento a clientes" hint="Recordatorios automáticos y clientes que vuelven.">
            <div className="grid gap-6 md:grid-cols-3">
              <div className="space-y-3">
                <RateBar label="Citas con recordatorio" value={s.followUp.reminderCoverage} hint="Citas del periodo que recibieron al menos un recordatorio." />
                <RateBar label="Confirmaron tras el recordatorio" value={s.followUp.confirmedAfterReminder} />
                <div className="grid grid-cols-2 gap-4 pt-1">
                  <Stat label="Recordatorios 24 h" value={int(s.followUp.remindersSent24h)} />
                  <Stat label="Recordatorios 2 h" value={int(s.followUp.remindersSent2h)} />
                </div>
              </div>
              <div className="space-y-3">
                <p className="text-sm font-medium text-slate-700">¿Los recordatorios reducen las faltas?</p>
                <RateBar label="No asistencia CON recordatorio" value={s.followUp.noShowRateWithReminder} />
                <RateBar label="No asistencia SIN recordatorio" value={s.followUp.noShowRateWithoutReminder} hint="Solo cuenta citas ya cerradas (realizadas o con falta)." />
              </div>
              <div className="space-y-3">
                <RateBar label="Clientes que regresan" value={s.followUp.returningRate} hint="Clientes con 2 o más citas / clientes con al menos una." />
                <div className="grid grid-cols-2 gap-4 pt-1">
                  <Stat label="Clientes recurrentes" value={int(s.followUp.returningClients)} />
                  <Stat label="Clientes con cita" value={int(s.followUp.clientsWithAppointments)} />
                </div>
              </div>
            </div>
          </Card>

          {/* ---- clientes, llamadas, equipo */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Clientes">
              <div className="grid grid-cols-2 gap-4">
                <Stat label="Total" value={int(s.contacts.total)} />
                <Stat label="Nuevos en el periodo" value={int(s.contacts.created)} />
                <Stat label="Aceptan promociones" value={int(s.contacts.marketingOptIn)} />
                <Stat label="Pidieron no recibir mensajes" value={int(s.contacts.optedOut)} />
              </div>
            </Card>
            <Card title="Llamadas" hint="Asistente telefónico.">
              {s.calls.total === 0 ? (
                <p className="text-sm text-slate-400">No hubo llamadas en este periodo.</p>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <Stat label="Llamadas" value={int(s.calls.total)} />
                    <Stat label="Duración típica" value={duration(s.calls.avgDurationSeconds)} />
                    <Stat label="Minutos totales" value={int(s.calls.totalMinutes)} />
                    <Stat label="Transferidas a una persona" value={int(s.calls.transferred)} />
                  </div>
                  <Stacked parts={[
                    { label: "Positivo", value: s.calls.sentiment.positive, color: "bg-teal-600" },
                    { label: "Neutral", value: s.calls.sentiment.neutral, color: "bg-slate-300" },
                    { label: "Negativo", value: s.calls.sentiment.negative, color: "bg-rose-500" },
                    { label: "Sin dato", value: s.calls.sentiment.unknown, color: "bg-slate-200" },
                  ]} />
                  {s.calls.failed > 0 && <p className="text-xs text-rose-700">{s.calls.failed} llamada(s) fallida(s).</p>}
                </div>
              )}
            </Card>
            <Card title="Tu equipo" hint="Escalaciones que tomó cada persona.">
              <HBars items={s.conversations.takenByPerson.map((p) => ({ name: p.name, count: p.count }))} empty="Nadie ha tomado escalaciones en este periodo." />
            </Card>
          </div>

          {/* ---- costo de IA (solo dueño) */}
          {s.ai && (
            <Card title="Costo de inteligencia artificial" hint="Solo lo ve el dueño. Es lo que consume tu asistente (modelos de lenguaje, voz y mensajes).">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Costo del periodo" value={usd(s.ai.costUsd)} />
                <Stat label="Por conversación" value={s.ai.costPerConversationUsd === null ? "—" : usd(s.ai.costPerConversationUsd)} />
                <Stat label="Tokens de entrada" value={int(s.ai.tokensIn)} />
                <Stat label="Tokens de salida" value={int(s.ai.tokensOut)} />
              </div>
              {s.ai.byKind.length > 0 && (
                <div className="mt-4">
                  <HBars items={s.ai.byKind.map((k) => ({ name: ({ llm: "Modelo de lenguaje", embedding: "Búsqueda en conocimiento", transcription: "Audios", whatsapp: "WhatsApp" } as Record<string, string>)[k.kind] ?? k.kind, count: k.costUsd }))} format={usd} />
                </div>
              )}
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
