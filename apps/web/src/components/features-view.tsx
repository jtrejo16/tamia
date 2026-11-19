"use client";

import type { NotificationSettingsView, ReviewSettingsView } from "@empleado/inbox";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { Alert, Badge, Button, Spinner, cx } from "./ui";

const field =
  "w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-900 ring-1 ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600 disabled:bg-slate-50 disabled:text-slate-500";

type TemplateInfo = { created: string[]; existing: string[] } | { error: string; details?: string } | null;
type Notice = { tone: "green" | "rose" | "amber"; text: string; details?: string[] };

const STATUS: Record<string, { label: string; tone: "green" | "amber" | "rose" | "slate" }> = {
  approved: { label: "Aprobada por Meta", tone: "green" },
  pending: { label: "En revisión de Meta", tone: "amber" },
  rejected: { label: "Rechazada por Meta", tone: "rose" },
};

function TemplateStatus({ template, hint }: { template: { status: string } | null; hint: string }) {
  if (!template) return <p className="text-xs text-slate-500">La plantilla de WhatsApp se envía a Meta para aprobación al guardar. {hint}</p>;
  const s = STATUS[template.status] ?? { label: template.status, tone: "slate" as const };
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
      Plantilla de WhatsApp: <Badge tone={s.tone}>{s.label}</Badge>
      {template.status === "pending" && <span>Hasta que Meta la apruebe, los mensajes no salen.</span>}
      {template.status === "rejected" && <span>Escríbenos para revisarla.</span>}
    </p>
  );
}

function templateNotice(t: TemplateInfo): Notice | null {
  if (!t) return null;
  if ("error" in t) {
    const why: Record<string, string> = {
      no_channel: "Conecta primero tu WhatsApp en la pestaña WhatsApp.",
      no_token: "Tu WhatsApp todavía no tiene su clave de acceso guardada.",
      no_waba: "Falta indicar la cuenta de WhatsApp Business del número.",
      meta_rejected: "Meta rechazó crear la plantilla.",
      meta_unavailable: "Meta no respondió.",
    };
    return { tone: "amber", text: `Se guardó, pero no pude enviar la plantilla a Meta. ${why[t.error] ?? ""} Vuelve a guardar para reintentar.`, details: t.details ? [t.details] : undefined };
  }
  return t.created.length > 0 ? { tone: "green", text: "Guardado. Envié la plantilla a Meta para su aprobación (puede tardar de minutos a un par de días)." } : null;
}

function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cx("relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50", on ? "bg-teal-700" : "bg-slate-300")}
    >
      <span className={cx("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", on ? "left-[22px]" : "left-0.5")} />
    </button>
  );
}

function useFeature<S>(feature: "avisos" | "resenas") {
  const [data, setData] = useState<{ settings: S; emailAvailable?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await api<{ ok: true; settings: S; emailAvailable?: boolean }>(`/api/features/${feature}`);
    if (res.ok) setData({ settings: res.settings, emailAvailable: res.emailAvailable });
    else setError(res.message);
  }, [feature]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, load };
}

// ------------------------------------------------------------------------- avisos

type Notif = Serialized<NotificationSettingsView>;
type Rec = Notif["recipients"][number];

/** Pestaña "Avisos": a quién avisar cuando una conversación necesita a una persona. */
export function NotificationsTab({ editable }: { editable: boolean }) {
  const { data, error, load } = useFeature<Notif>("avisos");
  const [form, setForm] = useState<Notif | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);

  if (error && !data) return <Alert>{error}</Alert>;
  if (!form || !data) return <div className="flex justify-center p-10 text-slate-400"><Spinner /></div>;

  const setRec = (i: number, patch: Partial<Rec>) => setForm({ ...form, recipients: form.recipients.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const hasWa = form.recipients.some((r) => r.kind === "whatsapp" && r.enabled);
  const hasMail = form.recipients.some((r) => r.kind === "email" && r.enabled);

  async function save() {
    setBusy(true);
    setNotice(null);
    const res = await api<{ ok: true; template: TemplateInfo }>("/api/features/avisos", { method: "POST", body: form });
    setBusy(false);
    if (!res.ok) return setNotice({ tone: "rose", text: res.message, details: res.details });
    setNotice(templateNotice(res.template) ?? { tone: "green", text: "Guardado." });
    await load();
  }

  return (
    <div className="space-y-4">
      <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold text-slate-900">Avisarme cuando alguien pida a una persona</h2>
            <p className="mt-1 text-sm text-slate-500">
              Cuando un cliente pide hablar con una persona, o el asistente detecta una urgencia o una queja, le llega un aviso a tu equipo con el nombre del cliente, el canal, el motivo y un enlace a la conversación.
            </p>
          </div>
          <Switch on={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} disabled={!editable} label="Activar avisos" />
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-700">¿A quién avisar? <span className="font-normal text-slate-500">(hasta 3)</span></p>
          {form.recipients.map((r, i) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2">
              <select className={cx(field, "w-36")} value={r.kind} onChange={(e) => setRec(i, { kind: e.target.value as Rec["kind"], address: "" })} disabled={!editable} aria-label="Tipo de aviso">
                <option value="whatsapp">WhatsApp</option>
                <option value="email">Correo</option>
              </select>
              <input className={cx(field, "min-w-0 flex-1")} value={r.address} onChange={(e) => setRec(i, { address: e.target.value })} disabled={!editable} placeholder={r.kind === "whatsapp" ? "999 123 4567" : "recepcion@tunegocio.com"} inputMode={r.kind === "whatsapp" ? "tel" : "email"} aria-label="Número o correo" />
              <label className="flex items-center gap-1.5 text-sm text-slate-600">
                <input type="checkbox" className="h-4 w-4 rounded accent-teal-700" checked={r.enabled} onChange={(e) => setRec(i, { enabled: e.target.checked })} disabled={!editable} /> Activo
              </label>
              {editable && <button type="button" onClick={() => setForm({ ...form, recipients: form.recipients.filter((_, j) => j !== i) })} className="rounded-lg px-2 py-1 text-sm text-rose-700 hover:bg-rose-50" aria-label="Quitar">Quitar</button>}
            </div>
          ))}
          {editable && form.recipients.length < 3 && (
            <Button variant="secondary" className="px-3 py-1.5 text-sm" onClick={() => setForm({ ...form, recipients: [...form.recipients, { id: `n${Date.now()}`, kind: "whatsapp", address: "", enabled: true }] })}>
              + Agregar destinatario
            </Button>
          )}
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-medium text-slate-700">¿A qué horas?</p>
          {([["business_hours", "Solo en horario de atención (Ajustes → Horarios). Lo pendiente sale cuando abren."], ["always", "A cualquier hora, aunque estén cerrados."]] as const).map(([v, text]) => (
            <label key={v} className="flex items-start gap-2 text-sm text-slate-700">
              <input type="radio" name="mode" className="mt-0.5 h-4 w-4 accent-teal-700" checked={form.mode === v} onChange={() => setForm({ ...form, mode: v })} disabled={!editable} />
              {text}
            </label>
          ))}
        </div>
      </section>

      {hasWa && !form.hasWhatsApp && <Alert tone="amber">Para avisar por WhatsApp primero conecta el WhatsApp de tu negocio (pestaña WhatsApp).</Alert>}
      {hasMail && !data.emailAvailable && <Alert tone="amber">El envío de correos todavía no está configurado en el servidor: los avisos por correo no saldrán hasta que se configure. Los de WhatsApp sí.</Alert>}
      {hasWa && (
        <section className="space-y-2 rounded-2xl bg-white p-5 text-sm text-slate-600 shadow-sm ring-1 ring-slate-200">
          <TemplateStatus template={form.template} hint="Cada aviso por WhatsApp cuenta como un mensaje de plantilla de Meta (lo cobra Meta a tu cuenta). Por correo es gratis." />
          <p className="text-xs text-slate-500">El aviso sale del WhatsApp de tu negocio hacia el número del equipo. Los avisos no se repiten: uno por conversación.</p>
        </section>
      )}

      {notice && <Alert tone={notice.tone}><p>{notice.text}</p>{notice.details && <ul className="mt-1 list-disc pl-5">{notice.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}</Alert>}
      {editable && <Button onClick={save} loading={busy}>Guardar</Button>}
    </div>
  );
}

// ------------------------------------------------------------------------- reseñas

type Rev = Serialized<ReviewSettingsView>;

const PLATFORMS: Array<{ id: Rev["platform"]; label: string; help: string; placeholder: string }> = [
  { id: "google", label: "Google", help: "En tu Perfil de Negocio de Google: «Pedir reseñas» → copia el enlace y pégalo aquí.", placeholder: "https://g.page/r/…/review" },
  { id: "facebook", label: "Facebook", help: "El enlace a las recomendaciones de tu página de Facebook.", placeholder: "https://www.facebook.com/tu-pagina/reviews" },
  { id: "other", label: "Otro sitio", help: "Doctoralia, TripAdvisor, Yelp… pega el enlace directo para dejar la reseña.", placeholder: "https://…" },
];

/** Pestaña "Reseñas": agradecer la visita y pedir una reseña unas horas después de la cita. */
export function ReviewsTab({ editable }: { editable: boolean }) {
  const { data, error, load } = useFeature<Rev>("resenas");
  const [form, setForm] = useState<Rev | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);

  if (error && !data) return <Alert>{error}</Alert>;
  if (!form) return <div className="flex justify-center p-10 text-slate-400"><Spinner /></div>;
  const p = PLATFORMS.find((x) => x.id === form.platform) ?? PLATFORMS[0]!;

  async function save() {
    setBusy(true);
    setNotice(null);
    const res = await api<{ ok: true; template: TemplateInfo }>("/api/features/resenas", { method: "POST", body: { enabled: form!.enabled, hoursAfter: Number(form!.hoursAfter), platform: form!.platform, url: form!.url } });
    setBusy(false);
    if (!res.ok) return setNotice({ tone: "rose", text: res.message, details: res.details });
    setNotice(templateNotice(res.template) ?? { tone: "green", text: "Guardado." });
    await load();
  }

  return (
    <div className="space-y-4">
      <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold text-slate-900">Pedir una reseña después de la cita</h2>
            <p className="mt-1 text-sm text-slate-500">Unas horas después de cada cita se le agradece la visita al cliente y se le pide una reseña, por WhatsApp.</p>
          </div>
          <Switch on={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} disabled={!editable} label="Activar reseñas" />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-700">¿Dónde quieres la reseña?
            <select className={cx(field, "mt-1")} value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value as Rev["platform"] })} disabled={!editable}>
              {PLATFORMS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium text-slate-700">¿Cuántas horas después de la cita?
            <input type="number" min={1} max={48} className={cx(field, "mt-1")} value={form.hoursAfter} onChange={(e) => setForm({ ...form, hoursAfter: Number(e.target.value) })} disabled={!editable} />
          </label>
        </div>
        <label className="block text-sm font-medium text-slate-700">Enlace para dejar la reseña
          <input className={cx(field, "mt-1")} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} disabled={!editable} placeholder={p.placeholder} inputMode="url" />
          <span className="mt-1 block text-xs font-normal text-slate-500">{p.help}</span>
        </label>

        <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700 ring-1 ring-slate-200">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Así lo recibe el cliente</p>
          <p className="mt-1">Hola Laura, gracias por tu visita a <b>{"{tu negocio}"}</b> y por elegirnos. Tu opinión nos ayuda a mejorar y a que más personas nos conozcan: ¿nos dejas una reseña? Solo toma un minuto: <span className="break-all text-teal-800">{form.url || "tu enlace"}</span> ¡Gracias!</p>
          <p className="mt-1 text-xs text-slate-500">El texto es fijo (Meta aprueba cada texto); solo cambian el nombre, tu negocio y el enlace.</p>
        </div>
      </section>

      {!form.hasWhatsApp && <Alert tone="amber">Para mandar las reseñas conecta primero el WhatsApp de tu negocio (pestaña WhatsApp).</Alert>}
      <section className="space-y-2 rounded-2xl bg-white p-5 text-sm text-slate-600 shadow-sm ring-1 ring-slate-200">
        <TemplateStatus template={form.template} hint="" />
        <ul className="list-disc space-y-1 pl-5 text-xs text-slate-500">
          <li>Se manda a todos los clientes con número de WhatsApp, sin importar por dónde agendaron.</li>
          <li>Una sola vez por cita, y una vez cada 90 días por cliente. No se manda en citas canceladas ni «No asistió», ni a quien pidió no recibir mensajes.</li>
          <li>Solo aplica a citas que terminen después de encender esta función.</li>
          <li>Se le pide a todos por igual y sin ofrecer nada a cambio: Google no permite filtrar a quién se le pide ni regalar algo por una reseña.</li>
          <li>Cada mensaje cuenta como una plantilla de Meta (lo cobra Meta a tu cuenta).</li>
        </ul>
      </section>

      {notice && <Alert tone={notice.tone}><p>{notice.text}</p>{notice.details && <ul className="mt-1 list-disc pl-5">{notice.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}</Alert>}
      {editable && <Button onClick={save} loading={busy}>Guardar</Button>}
    </div>
  );
}
