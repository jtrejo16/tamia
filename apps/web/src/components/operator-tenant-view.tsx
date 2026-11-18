"use client";

import type { TenantDetail } from "@empleado/inbox";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, usePolling } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { StatsView } from "./stats-view";
import { ago, BUCKET, ChannelChips, dayLabel, HEALTH, money, whenLabel } from "./operator-view";
import { Alert, Badge, Button, Spinner, cx } from "./ui";

type Detail = Serialized<TenantDetail>;

const field =
  "w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-900 ring-1 ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600";

const TENANT_STATUS: Record<string, { label: string; tone: "amber" | "green" | "slate" | "rose" }> = {
  pending: { label: "Pendiente de aprobar", tone: "amber" },
  active: { label: "Activo", tone: "green" },
  paused: { label: "Pausado", tone: "slate" },
  cancelled: { label: "Cancelado", tone: "rose" },
};

const FB_MESSAGES: Record<string, { tone: "rose" | "amber" | "green"; text: string }> = {
  denied: { tone: "amber", text: "Se canceló el inicio de sesión con Facebook." },
  forbidden: { tone: "rose", text: "No tienes permiso para conectar a este cliente." },
  unavailable: { tone: "amber", text: "Facebook no está configurado en el servidor (faltan META_APP_ID / META_APP_SECRET)." },
  invalid: { tone: "rose", text: "El inicio de sesión expiró o no era válido. Vuelve a intentarlo." },
  no_pages: { tone: "amber", text: "Esa cuenta de Facebook no administra ninguna página. Pide al cliente que te dé acceso a su página en Meta." },
  meta_rejected: { tone: "rose", text: "Meta rechazó la operación." },
  meta_unavailable: { tone: "rose", text: "Meta no respondió. Inténtalo en unos minutos." },
};

const ACTION_LABEL: Record<string, string> = {
  "operator.set_status": "Cambio de estado (operador)",
  "operator.set_comped": "Cortesía (operador)",
  "operator.extend_trial": "Prueba extendida (operador)",
  "operator.support.whatsapp_connect": "Soporte: conectó WhatsApp",
  "operator.support.whatsapp_disconnect": "Soporte: desconectó WhatsApp",
  "operator.support.social_connect": "Soporte: conectó Messenger/Instagram",
  "operator.support.social_disconnect": "Soporte: desconectó Messenger/Instagram",
  "operator.support.check": "Soporte: comprobó conexiones",
  "operator.support.voice_sync": "Soporte: sincronizó las llamadas",
  "operator.support.templates_sync": "Soporte: sincronizó plantillas",
  "channel.connect": "Canal conectado",
  "channel.disconnect": "Canal desconectado",
  "calendar.connect": "Calendario conectado",
  "calendar.disconnect": "Calendario desconectado",
  "voice.settings": "Ajustes de llamadas",
  signup: "Alta del negocio",
};

function Card({ title, hint, children, action }: { title: string; hint?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold text-slate-900">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const Row = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="flex justify-between gap-3 border-b border-slate-100 py-1.5 text-sm last:border-0">
    <span className="text-slate-500">{label}</span>
    <span className="text-right font-medium text-slate-900">{value}</span>
  </div>
);

const OnOff = ({ ok, on, off }: { ok: boolean; on: string; off: string }) => <Badge tone={ok ? "green" : "slate"}>{ok ? on : off}</Badge>;

interface CheckResult {
  whatsapp: { connected: boolean; tokenValid: boolean; displayPhone: string | null; verifiedName: string | null; quality: string | null; problems: string[] };
  social: Array<{ type: string; tokenValid: boolean; subscribed: boolean; problems: string[] }>;
  socialAvailable: boolean;
}

export function OperatorTenantView({ tenantId }: { tenantId: string }) {
  const { data, error, loading, reload } = usePolling<{ ok: true; detail: Detail }>(`/api/operator/tenant?id=${tenantId}`, 60_000);
  const [notice, setNotice] = useState<{ tone: "green" | "rose" | "amber"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [wa, setWa] = useState({ phoneNumberId: "", wabaId: "", accessToken: "" });
  const [pages, setPages] = useState<Array<{ pageId: string; name: string; instagram: { username: string | null } | null }> | null>(null);
  const [pick, setPick] = useState<{ pageId: string; messenger: boolean; instagram: boolean }>({ pageId: "", messenger: true, instagram: true });
  const [trialDays, setTrialDays] = useState(7);
  const [showStats, setShowStats] = useState(false);

  // Al volver de Facebook: ?fb=<resultado> (pick = elegir pagina).
  useEffect(() => {
    const fb = new URLSearchParams(window.location.search).get("fb");
    if (!fb) return;
    window.history.replaceState(null, "", `/operador/${tenantId}`);
    if (fb === "pick") {
      void (async () => {
        const res = await api<{ ok: true; pages: NonNullable<typeof pages> }>(`/api/operator/facebook/pages?tenant=${tenantId}`);
        if (res.ok && res.pages.length > 0) {
          setPages(res.pages);
          setPick({ pageId: res.pages[0]!.pageId, messenger: true, instagram: Boolean(res.pages[0]!.instagram) });
        } else setNotice(FB_MESSAGES.no_pages!);
      })();
    } else setNotice(FB_MESSAGES[fb] ?? { tone: "rose", text: "No se pudo conectar con Facebook." });
  }, [tenantId]);

  const act = useCallback(
    async (key: string, url: string, body: Record<string, unknown>, okText: string, confirmText?: string) => {
      if (confirmText && !window.confirm(confirmText)) return null;
      setBusy(key);
      setNotice(null);
      const res = await api<{ ok: true }>(url, { method: "POST", body: { tenantId, ...body } });
      setBusy(null);
      setNotice(res.ok ? { tone: "green", text: okText } : { tone: "rose", text: [res.message, ...(res.details ?? [])].join(" ") });
      await reload();
      return res;
    },
    [tenantId, reload],
  );

  async function runCheck() {
    setBusy("check");
    setNotice(null);
    const res = await api<{ ok: true } & CheckResult>("/api/operator/support/check", { method: "POST", body: { tenantId } });
    setBusy(null);
    if (res.ok) setCheck(res);
    else setNotice({ tone: "rose", text: res.message });
  }

  async function connectWhatsApp() {
    const res = await act("wa", "/api/operator/support/whatsapp-connect", wa, "WhatsApp conectado ✓");
    if (res?.ok) setWa({ phoneNumberId: "", wabaId: "", accessToken: "" }); // la clave no se queda en pantalla
  }

  async function connectPage() {
    const res = await act("fbsel", "/api/operator/facebook/select", pick, "Conectado ✓");
    if (res?.ok) setPages(null);
  }

  if (!data) return <div className="flex justify-center p-10 text-slate-400">{error ? <Alert>{error.message}</Alert> : loading ? <Spinner /> : null}</div>;
  const d = data.detail;
  const c = d.client;
  const st = TENANT_STATUS[c.status] ?? { label: c.status, tone: "slate" as const };
  const b = BUCKET[c.billing.bucket];
  const h = HEALTH[c.health.level] ?? HEALTH.na!;
  const waChannel = c.channels.find((x) => x.type === "whatsapp");
  const selected = pages?.find((p) => p.pageId === pick.pageId);

  return (
    <div className="mx-auto h-full max-w-6xl space-y-4 overflow-y-auto p-4 sm:p-6">
      <Link href="/operador" className="text-sm font-medium text-teal-800 hover:underline">← Todos los clientes</Link>

      {/* ---- encabezado y acciones */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold text-slate-900">{c.name}</h1>
            <Badge tone={st.tone}>{st.label}</Badge>
            <Badge tone={b.tone}>{b.label}</Badge>
          </div>
          <p className="text-sm text-slate-500">{c.ownerName ?? "—"} · {c.ownerEmail ?? "sin dueño"} · plan {c.plan} · {c.vertical} · alta {dayLabel(c.createdAt)} · {c.timezone}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {c.status !== "active" && <Button className="px-3 py-1.5" loading={busy === "st-a"} onClick={() => act("st-a", "/api/operator/status", { status: "active" }, c.status === "pending" ? "Cliente aprobado ✓" : "Cliente reactivado ✓")}>{c.status === "pending" ? "Aprobar" : "Reactivar"}</Button>}
          {c.status === "active" && <Button variant="secondary" className="px-3 py-1.5" loading={busy === "st-p"} onClick={() => act("st-p", "/api/operator/status", { status: "paused" }, "Cliente pausado.", `¿Pausar a ${c.name}? Sus usuarios no podrán entrar y el asistente dejará de responder.`)}>Pausar</Button>}
          {c.status === "pending" && <Button variant="danger" className="px-3 py-1.5" loading={busy === "st-c"} onClick={() => act("st-c", "/api/operator/status", { status: "cancelled" }, "Cliente rechazado.", `¿Rechazar y cancelar a ${c.name}?`)}>Rechazar</Button>}
          <Button variant="ghost" className="px-3 py-1.5" loading={busy === "comp"} onClick={() => act("comp", "/api/operator/comped", { on: c.subStatus !== "comped" }, c.subStatus === "comped" ? "Cortesía quitada." : "Cortesía dada ✓")}>{c.subStatus === "comped" ? "Quitar cortesía" : "Dar cortesía"}</Button>
        </div>
      </div>

      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---- salud */}
        <Card title="Salud del servicio" hint="Lo que hay que atender de este cliente ahora." action={<Button variant="secondary" className="px-3 py-1.5" loading={busy === "check"} onClick={runCheck}>Comprobar conexiones ahora</Button>}>
          <div className="mb-3 flex items-center gap-2"><span className={cx("h-3 w-3 rounded-full", h.dot)} /><span className="font-medium text-slate-900">{h.label}</span></div>
          {c.health.issues.length === 0 ? (
            <p className="text-sm text-slate-500">{c.status === "active" ? "Sin problemas detectados." : "El negocio no está activo: no se evalúa."}</p>
          ) : (
            <ul className="space-y-2">
              {c.health.issues.map((i) => (
                <li key={i.code} className={cx("rounded-lg px-3 py-2 text-sm", i.level === "error" ? "bg-rose-50 text-rose-900" : i.level === "warn" ? "bg-amber-50 text-amber-900" : "bg-slate-50 text-slate-700")}>{i.text}</li>
              ))}
            </ul>
          )}
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <Row label="Mensajes 7 d" value={c.inbound7d} />
            <Row label="Respuestas IA 7 d" value={c.bot7d} />
            <Row label="Fallidos 24 h" value={c.failed24h} />
            <Row label="Último del cliente" value={ago(c.lastInboundAt)} />
            <Row label="Última respuesta" value={ago(c.lastOutboundAt)} />
            <Row label="Citas próximas 7 d" value={c.appointmentsNext7d} />
            <Row label="Escalaciones abiertas" value={c.openHandoffs} />
            <Row label="Borradores pendientes" value={c.pendingApprovals} />
            <Row label="Usuarios" value={c.members} />
          </div>
        </Card>

        {/* ---- cobro */}
        <Card title="Cobro" hint="Suscripción con Mercado Pago.">
          <Row label="Estado" value={<Badge tone={b.tone}>{b.label}</Badge>} />
          <Row label="Plan" value={`${c.plan}${c.billing.mrrMxn ? ` · ${money(c.billing.mrrMxn)}/mes` : ""}`} />
          <Row label="Suscripción" value={d.billing.subscription?.status ?? "—"} />
          <Row label={c.billing.bucket === "trial" || c.billing.bucket === "trial_ending" ? "La prueba termina" : c.billing.bucket === "canceled" ? "Acceso hasta" : c.billing.bucket === "overdue" ? "Venció" : "Próximo cobro"} value={c.billing.dueAt ? `${dayLabel(c.billing.dueAt)} (${whenLabel(c.billing.daysLeft)})` : "—"} />
          <Row label="Tarjeta autorizada" value={<OnOff ok={c.cardAuthorized} on="Sí" off="No" />} />
          <Row label="Checkout iniciado" value={<OnOff ok={c.hasCheckout} on="Sí" off="No" />} />
          <Row label="Último estado confirmado con Mercado Pago" value={c.reconciledAt ? ago(c.reconciledAt) : "nunca"} />
          <Row label="El asistente responde hoy" value={<OnOff ok={c.billing.allowed} on="Sí" off={`No (${c.billing.reason})`} />} />
          {(c.billing.bucket === "trial" || c.billing.bucket === "trial_ending") && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <label className="text-sm text-slate-600" htmlFor="trialDays">Extender la prueba</label>
              <select id="trialDays" value={trialDays} onChange={(e) => setTrialDays(Number(e.target.value))} className="rounded-lg bg-white px-2 py-1.5 text-sm ring-1 ring-slate-300">
                {[3, 7, 14, 30].map((n) => <option key={n} value={n}>{n} días</option>)}
              </select>
              <Button variant="secondary" className="px-3 py-1.5" loading={busy === "trial"} onClick={() => act("trial", "/api/operator/extend-trial", { days: trialDays }, `Prueba extendida ${trialDays} días ✓`, `¿Extender la prueba de ${c.name} ${trialDays} días?`)}>Extender</Button>
            </div>
          )}
        </Card>
      </div>

      {/* ---- conexiones */}
      <h2 className="pt-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Conexiones</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="WhatsApp" hint="Número de WhatsApp Business del cliente."
          action={d.whatsapp.hasToken && <Button variant="danger" className="px-3 py-1.5" loading={busy === "wa-off"} onClick={() => act("wa-off", "/api/operator/support/whatsapp-disconnect", {}, "WhatsApp desconectado.", `¿Desconectar el WhatsApp de ${c.name}? Dejará de recibir y enviar mensajes.`)}>Desconectar</Button>}>
          <Row label="Estado" value={<OnOff ok={d.whatsapp.connected} on="Conectado" off={d.whatsapp.hasToken ? "Con problemas" : "Sin conectar"} />} />
          <Row label="Número" value={d.whatsapp.displayPhone ?? "—"} />
          <Row label="Identificador del número" value={<span className="font-mono text-xs">{d.whatsapp.phoneNumberId ?? "—"}</span>} />
          <Row label="Cuenta de WhatsApp Business" value={<span className="font-mono text-xs">{d.whatsapp.wabaId ?? "—"}</span>} />
          <Row label="Calidad" value={d.whatsapp.qualityRating ?? "—"} />
          {check && (
            <div className="mt-3">
              {check.whatsapp.problems.length === 0 ? <Alert tone="green">Meta responde bien: clave válida{check.whatsapp.displayPhone ? `, número ${check.whatsapp.displayPhone}` : ""}{check.whatsapp.quality ? `, calidad ${check.whatsapp.quality}` : ""}.</Alert> : <Alert tone="amber">{check.whatsapp.problems.join(" ")}</Alert>}
            </div>
          )}
          <details className="mt-4 rounded-lg bg-slate-50 p-3" open={!d.whatsapp.hasToken}>
            <summary className="cursor-pointer text-sm font-medium text-slate-700">{d.whatsapp.hasToken ? "Reconectar con otra clave o número" : "Conectar el número"}</summary>
            <div className="mt-3 grid gap-3">
              <label className="block text-sm font-medium text-slate-700">Identificador del número (Phone number ID)
                <input className={cx(field, "mt-1 font-mono")} inputMode="numeric" value={wa.phoneNumberId} onChange={(e) => setWa((p) => ({ ...p, phoneNumberId: e.target.value }))} /></label>
              <label className="block text-sm font-medium text-slate-700">Cuenta de WhatsApp Business (WABA ID)
                <input className={cx(field, "mt-1 font-mono")} inputMode="numeric" value={wa.wabaId} onChange={(e) => setWa((p) => ({ ...p, wabaId: e.target.value }))} /></label>
              <label className="block text-sm font-medium text-slate-700">Clave de acceso permanente
                <input className={cx(field, "mt-1 font-mono")} type="password" autoComplete="off" value={wa.accessToken} onChange={(e) => setWa((p) => ({ ...p, accessToken: e.target.value }))} placeholder="Se guarda cifrada y no vuelve a mostrarse" /></label>
              <div><Button loading={busy === "wa"} disabled={!wa.phoneNumberId || !wa.wabaId || !wa.accessToken} onClick={connectWhatsApp}>Verificar y conectar</Button></div>
            </div>
          </details>
        </Card>

        <Card title="Messenger e Instagram" hint="Se conectan con Facebook: usa una cuenta que administre la página del cliente (pídele que te agregue en Meta)."
          action={<a href={`/api/operator/facebook/start?tenant=${tenantId}`} className="inline-flex items-center rounded-lg bg-[#1877f2] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">Conectar con Facebook</a>}>
          {d.social.length === 0 ? (
            <p className="text-sm text-slate-500">Aún no hay Messenger ni Instagram conectados.</p>
          ) : (
            <ul className="space-y-2">
              {d.social.map((s) => {
                const r = check?.social.find((x) => x.type === s.type);
                return (
                  <li key={s.type} className="rounded-lg bg-slate-50 p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="font-medium text-slate-900">{s.type === "messenger" ? "Messenger" : "Instagram"}</span>
                        <span className="text-slate-500"> · {s.name ?? "—"}{s.handle ? ` (@${s.handle})` : ""}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <OnOff ok={s.status === "active" && s.hasToken} on="Conectado" off={s.status === "error" ? "Con error" : "Desconectado"} />
                        {s.hasToken && <Button variant="danger" className="px-2.5 py-1" loading={busy === `so-${s.type}`} onClick={() => act(`so-${s.type}`, "/api/operator/support/social-disconnect", { type: s.type }, "Desconectado.", `¿Desconectar ${s.type === "messenger" ? "Messenger" : "Instagram"} de ${c.name}?`)}>Quitar</Button>}
                      </div>
                    </div>
                    {r && (r.problems.length === 0 ? <p className="mt-2 text-xs text-emerald-700">Meta responde bien y la página está suscrita a los mensajes.</p> : <p className="mt-2 text-xs text-amber-800">{r.problems.join(" ")}</p>)}
                  </li>
                );
              })}
            </ul>
          )}
          {check && !check.socialAvailable && <p className="mt-2 text-xs text-amber-700">Facebook no está configurado en el servidor: no se pueden comprobar ni conectar.</p>}

          {pages && (
            <div className="mt-4 space-y-3 rounded-lg bg-sky-50 p-3 text-sm">
              <p className="font-medium text-sky-900">Elige la página de {c.name}</p>
              <select className={field} value={pick.pageId} onChange={(e) => { const p = pages.find((x) => x.pageId === e.target.value); setPick({ pageId: e.target.value, messenger: true, instagram: Boolean(p?.instagram) }); }}>
                {pages.map((p) => <option key={p.pageId} value={p.pageId}>{p.name}{p.instagram ? ` · Instagram${p.instagram.username ? ` @${p.instagram.username}` : ""}` : ""}</option>)}
              </select>
              <label className="flex items-center gap-2"><input type="checkbox" checked={pick.messenger} onChange={(e) => setPick((p) => ({ ...p, messenger: e.target.checked }))} /> Conectar Messenger</label>
              <label className={cx("flex items-center gap-2", !selected?.instagram && "text-slate-400")}><input type="checkbox" disabled={!selected?.instagram} checked={pick.instagram && Boolean(selected?.instagram)} onChange={(e) => setPick((p) => ({ ...p, instagram: e.target.checked }))} /> Conectar Instagram {selected?.instagram ? "" : "(esta página no tiene Instagram vinculado)"}</label>
              <div className="flex gap-2">
                <Button loading={busy === "fbsel"} disabled={!pick.messenger && !(pick.instagram && selected?.instagram)} onClick={connectPage}>Conectar a {c.name}</Button>
                <Button variant="ghost" onClick={() => setPages(null)}>Cancelar</Button>
              </div>
            </div>
          )}
        </Card>

        <Card title="Llamadas (asistente telefónico)" hint="Agente de voz en Retell."
          action={<Button variant="secondary" className="px-3 py-1.5" loading={busy === "voice"} disabled={!d.voice.retellConfigured} onClick={() => act("voice", "/api/operator/support/voice-sync", {}, "Agente sincronizado con Retell ✓")}>Sincronizar con Retell</Button>}>
          <Row label="Activado" value={<OnOff ok={d.voice.enabled} on="Sí" off="No" />} />
          <Row label="Sincronizado" value={<OnOff ok={d.voice.synced} on="Sí" off="No" />} />
          <Row label="Número" value={d.voice.phoneNumber || "—"} />
          <Row label="Transferencia a recepción" value={d.voice.transferNumber || "—"} />
          <Row label="Agenda por teléfono" value={<OnOff ok={d.voice.allowBooking} on="Sí" off="No" />} />
          {!d.voice.retellConfigured && <p className="mt-2 text-xs text-amber-700">Retell no está configurado en el servidor.</p>}
        </Card>

        <Card title="Plantillas de WhatsApp y calendario" hint="Mensajes de recordatorio aprobados por Meta y Google Calendar."
          action={<Button variant="secondary" className="px-3 py-1.5" loading={busy === "tpl"} disabled={!d.whatsapp.hasToken} onClick={() => act("tpl", "/api/operator/support/templates-sync", {}, "Plantillas sincronizadas ✓")}>Sincronizar plantillas</Button>}>
          {d.templates.length === 0 ? <p className="text-sm text-slate-500">Sin plantillas.</p> : (
            <ul className="space-y-1.5 text-sm">
              {d.templates.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2"><span className="truncate text-slate-700">{t.name}</span>
                  <Badge tone={t.status === "approved" ? "green" : t.status === "rejected" ? "rose" : "amber"}>{t.status === "approved" ? "Aprobada" : t.status === "rejected" ? "Rechazada" : t.status === "pending" ? "En revisión" : t.status}</Badge></li>
              ))}
            </ul>
          )}
          <div className="mt-3 border-t border-slate-100 pt-3">
            <Row label="Google Calendar" value={d.calendar.connected ? <Badge tone={d.calendar.status === "error" ? "rose" : "green"}>{d.calendar.status === "error" ? "Requiere reconectar" : `Conectado${d.calendar.accountEmail ? ` · ${d.calendar.accountEmail}` : ""}`}</Badge> : <Badge tone="slate">Sin conectar</Badge>} />
          </div>
        </Card>
      </div>

      {/* ---- equipo, fallos y bitacora */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Equipo" hint="Personas con acceso a su panel.">
          <ul className="space-y-2 text-sm">
            {d.members.map((m) => (
              <li key={m.userId} className="flex items-center justify-between gap-2">
                <div className="min-w-0"><p className="truncate font-medium text-slate-900">{m.name ?? m.email}</p><p className="truncate text-xs text-slate-500">{m.email}</p></div>
                <Badge tone={m.role === "owner" ? "teal" : "slate"}>{m.role === "owner" ? "Dueño" : m.role === "agent" ? "Recepción" : "Lector"}</Badge>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Mensajes fallidos recientes">
          {d.failures.length === 0 ? <p className="text-sm text-slate-500">Ninguno. 🎉</p> : (
            <ul className="space-y-2 text-sm">
              {d.failures.map((f, i) => (
                <li key={i} className="rounded-lg bg-rose-50 p-2 text-rose-900"><p>{f.error ?? "Sin detalle"}</p><p className="mt-0.5 text-[11px] text-rose-700">{f.channel} · {ago(f.at)}</p></li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Bitácora" hint="Quién hizo qué en este negocio.">
          {d.audit.length === 0 ? <p className="text-sm text-slate-500">Sin movimientos.</p> : (
            <ul className="max-h-72 space-y-2 overflow-y-auto text-sm">
              {d.audit.map((a) => (
                <li key={a.id} className="border-b border-slate-100 pb-2 last:border-0">
                  <p className="text-slate-800">{ACTION_LABEL[a.action] ?? a.action}</p>
                  <p className="text-[11px] text-slate-400">{a.by ?? "Sistema"} · {ago(a.at)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* ---- estadisticas del cliente */}
      <div>
        <Button variant="secondary" onClick={() => setShowStats((v) => !v)}>{showStats ? "Ocultar" : "Ver"} estadísticas completas de este cliente</Button>
        {showStats && <div className="mt-3"><StatsView tenantId={tenantId} embedded /></div>}
      </div>
    </div>
  );
}
