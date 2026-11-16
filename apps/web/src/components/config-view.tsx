"use client";

import type { ConfigSnapshot } from "@empleado/inbox";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { usePanel } from "./panel-context";
import { Alert, Badge, Button, Spinner, cx } from "./ui";
import { ChannelTab } from "./channel-view";
import { SocialTab } from "./social-view";
import { UsersTab } from "./users-view";

type Config = Serialized<ConfigSnapshot>;
type Tab = "negocio" | "asistente" | "servicios" | "equipo" | "horarios" | "conocimiento" | "plantillas" | "whatsapp" | "redes" | "usuarios";

const TABS: Array<{ id: Tab; label: string; ownerOnly?: boolean }> = [
  { id: "negocio", label: "Negocio" },
  { id: "asistente", label: "Asistente" },
  { id: "servicios", label: "Servicios" },
  { id: "equipo", label: "Equipo" },
  { id: "horarios", label: "Horarios" },
  { id: "conocimiento", label: "Conocimiento" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "redes", label: "Messenger e Instagram" },
  { id: "plantillas", label: "Plantillas" },
  { id: "usuarios", label: "Usuarios", ownerOnly: true },
];

const field =
  "w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-900 ring-1 ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600 disabled:bg-slate-50 disabled:text-slate-500";

// ------------------------------------------------------------------ ayudas

function useConfig() {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const res = await api<{ ok: true; config: Config }>("/api/config");
    if (res.ok) {
      setConfig(res.config);
      setError(null);
    } else setError(res.message);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { config, error, reload };
}

interface Notice {
  tone: "green" | "rose";
  text: string;
  details?: string[];
}

/** Guarda en /api/config/:section y devuelve el aviso para mostrar. */
function useSaver(reload: () => Promise<void>) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function run<T extends { ok: true }>(key: string, section: string, body: unknown, okText = "Guardado ✓"): Promise<T | null> {
    setBusy(key);
    setNotice(null);
    const res = await api<T>(`/api/config/${section}`, { method: "POST", body });
    setBusy(null);
    if (res.ok) {
      setNotice({ tone: "green", text: okText });
      await reload();
      return res;
    }
    setNotice({ tone: "rose", text: res.message, details: res.details ?? (res as { details?: string[] }).details });
    return null;
  }
  return { busy, notice, run, clear: () => setNotice(null) };
}

function NoticeBox({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <Alert tone={notice.tone === "green" ? "green" : "rose"}>
      <p className="font-medium">{notice.text}</p>
      {notice.details && notice.details.length > 0 && (
        <ul className="mt-1 list-disc pl-5">{notice.details.map((d, i) => <li key={i}>{d}</li>)}</ul>
      )}
    </Alert>
  );
}

function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

function Card({ title, hint, children }: { title?: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      {title && (
        <div>
          <h2 className="font-semibold text-slate-900">{title}</h2>
          {hint && <p className="mt-0.5 text-sm text-slate-500">{hint}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

const DAYS: Array<{ key: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"; weekday: number; label: string }> = [
  { key: "mon", weekday: 1, label: "Lunes" },
  { key: "tue", weekday: 2, label: "Martes" },
  { key: "wed", weekday: 3, label: "Miércoles" },
  { key: "thu", weekday: 4, label: "Jueves" },
  { key: "fri", weekday: 5, label: "Viernes" },
  { key: "sat", weekday: 6, label: "Sábado" },
  { key: "sun", weekday: 0, label: "Domingo" },
];

// ------------------------------------------------------------------- vista

export function ConfigView() {
  const panel = usePanel();
  const { config, error, reload } = useConfig();
  const [tab, setTab] = useState<Tab>("negocio");
  // Al volver de Facebook se abre directo la pestaña de redes (?tab=redes); en efecto para no desajustar la hidratación.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("tab") === "redes") setTab("redes");
  }, []);

  const editable = panel.role === "owner";

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-4 lg:p-6">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Configuración</h1>
          <p className="text-sm text-slate-500">Todo lo que el asistente sabe y hace sale de aquí. Los cambios se aplican en cuanto guardas.</p>
        </div>
        {!editable && <Alert tone="amber">Solo el dueño puede cambiar la configuración. Tú puedes consultarla.</Alert>}

        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {TABS.filter((t) => !t.ownerOnly || editable).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cx(
                "shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
                tab === t.id ? "bg-teal-700 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "whatsapp" ? (
          <ChannelTab editable={editable} />
        ) : tab === "redes" ? (
          <SocialTab editable={editable} />
        ) : tab === "usuarios" && editable ? (
          <UsersTab />
        ) : error && !config ? (
          <Alert>{error}</Alert>
        ) : !config ? (
          <div className="flex justify-center p-10 text-slate-400"><Spinner /></div>
        ) : (
          <>
            {tab === "negocio" && <BusinessTab config={config} editable={editable} reload={reload} />}
            {tab === "asistente" && <AgentTab config={config} editable={editable} reload={reload} />}
            {tab === "servicios" && <ServicesTab config={config} editable={editable} reload={reload} />}
            {tab === "equipo" && <TeamTab config={config} editable={editable} reload={reload} />}
            {tab === "horarios" && <HoursTab config={config} editable={editable} reload={reload} />}
            {tab === "conocimiento" && <KnowledgeTab config={config} editable={editable} reload={reload} />}
            {tab === "plantillas" && <TemplatesTab config={config} editable={editable} reload={reload} />}
          </>
        )}
      </div>
    </div>
  );
}

interface TabProps {
  config: Config;
  editable: boolean;
  reload: () => Promise<void>;
}

// ------------------------------------------------------------------- negocio

function BusinessTab({ config, editable, reload }: TabProps) {
  const b = config.business;
  const saver = useSaver(reload);
  const [f, setF] = useState({
    name: b.name,
    description: b.description,
    address: b.address,
    mapsUrl: b.mapsUrl,
    latitude: b.latitude?.toString() ?? "",
    longitude: b.longitude?.toString() ?? "",
    payment: b.paymentMethods.join("\n"),
    facts: b.keyFacts.join("\n"),
    cancellationPolicy: b.cancellationPolicy,
    cancellationNoticeHours: String(b.cancellationNoticeHours),
    depositPolicy: b.depositPolicy,
    privacyNoticeUrl: b.privacyNoticeUrl,
    timezone: b.timezone,
  });
  const [human, setHuman] = useState<Record<string, [string, string] | null>>(
    () =>
      Object.fromEntries(
        DAYS.map((d) => {
          const v = b.humanHours[d.key];
          return [d.key, v && v.length === 2 ? ([v[0]!, v[1]!] as [string, string]) : null];
        }),
      ) as Record<string, [string, string] | null>,
  );
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  function submit() {
    const lat = Number(f.latitude);
    const lng = Number(f.longitude);
    void saver.run("business", "business", {
      name: f.name,
      description: f.description,
      address: f.address,
      mapsUrl: f.mapsUrl,
      ...(f.latitude.trim() && f.longitude.trim() && Number.isFinite(lat) && Number.isFinite(lng) ? { latitude: lat, longitude: lng } : {}),
      paymentMethods: lines(f.payment),
      keyFacts: lines(f.facts),
      cancellationPolicy: f.cancellationPolicy,
      cancellationNoticeHours: Number(f.cancellationNoticeHours),
      depositPolicy: f.depositPolicy,
      privacyNoticeUrl: f.privacyNoticeUrl,
      timezone: f.timezone,
      humanHours: human,
    });
  }

  return (
    <div className="space-y-4">
      <Card title="Datos del negocio" hint="El asistente los usa para presentarse y responder dónde y cómo.">
        <Field label="Nombre del negocio"><input className={field} value={f.name} onChange={set("name")} disabled={!editable} /></Field>
        <Field label="Descripción corta" hint="Una frase: “clínica dental familiar en Mérida con más de 10 años de experiencia”.">
          <input className={field} value={f.description} onChange={set("description")} disabled={!editable} maxLength={300} />
        </Field>
        <Field label="Dirección"><input className={field} value={f.address} onChange={set("address")} disabled={!editable} /></Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Enlace de Google Maps" className="sm:col-span-3"><input className={field} value={f.mapsUrl} onChange={set("mapsUrl")} disabled={!editable} placeholder="https://maps.google.com/…" /></Field>
          <Field label="Latitud" hint="Opcional: permite enviar la ubicación como pin en WhatsApp."><input className={field} value={f.latitude} onChange={set("latitude")} disabled={!editable} inputMode="decimal" /></Field>
          <Field label="Longitud"><input className={field} value={f.longitude} onChange={set("longitude")} disabled={!editable} inputMode="decimal" /></Field>
          <Field label="Zona horaria"><input className={field} value={f.timezone} onChange={set("timezone")} disabled={!editable} /></Field>
        </div>
      </Card>

      <Card title="Pagos, políticas y datos clave">
        <Field label="Formas de pago" hint="Una por renglón."><textarea className={field} rows={3} value={f.payment} onChange={set("payment")} disabled={!editable} /></Field>
        <Field label="Datos clave" hint="Una por renglón: estacionamiento, accesibilidad, edad mínima de pacientes…"><textarea className={field} rows={3} value={f.facts} onChange={set("facts")} disabled={!editable} /></Field>
        <Field label="Política de cancelación"><textarea className={field} rows={2} value={f.cancellationPolicy} onChange={set("cancellationPolicy")} disabled={!editable} maxLength={300} /></Field>
        <Field label="Horas de aviso para cambiar o cancelar" hint="Con menos aviso, el asistente no lo hace solo: lo pasa a una persona.">
          <input className={cx(field, "max-w-[8rem]")} type="number" min={0} max={168} value={f.cancellationNoticeHours} onChange={set("cancellationNoticeHours")} disabled={!editable} />
        </Field>
        <Field label="Política de anticipo"><textarea className={field} rows={2} value={f.depositPolicy} onChange={set("depositPolicy")} disabled={!editable} maxLength={300} /></Field>
        <Field label="Aviso de privacidad (enlace)" hint="Si es un negocio de salud, es obligatorio por ley."><input className={field} value={f.privacyNoticeUrl} onChange={set("privacyNoticeUrl")} disabled={!editable} placeholder="https://…" /></Field>
      </Card>

      <Card title="Horario de atención humana" hint="Cuándo contesta una persona. Fuera de este horario, el asistente avisa cuándo le responderán.">
        <div className="space-y-2">
          {DAYS.map((d) => {
            const v = human[d.key] ?? null;
            return (
              <div key={d.key} className="flex flex-wrap items-center gap-3">
                <label className="flex w-32 items-center gap-2 text-sm font-medium text-slate-700">
                  <input type="checkbox" className="h-4 w-4 rounded accent-teal-700" checked={Boolean(v)} disabled={!editable} onChange={(e) => setHuman((p) => ({ ...p, [d.key]: e.target.checked ? ["09:00", "18:00"] : null }))} />
                  {d.label}
                </label>
                {v ? (
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <input type="time" className={cx(field, "w-28")} value={v[0]} disabled={!editable} onChange={(e) => setHuman((p) => ({ ...p, [d.key]: [e.target.value, v[1]] }))} />
                    a
                    <input type="time" className={cx(field, "w-28")} value={v[1]} disabled={!editable} onChange={(e) => setHuman((p) => ({ ...p, [d.key]: [v[0], e.target.value] }))} />
                  </div>
                ) : (
                  <span className="text-sm text-slate-400">Sin atención</span>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <NoticeBox notice={saver.notice} />
      {editable && <Button onClick={submit} loading={saver.busy === "business"}>Guardar cambios</Button>}
    </div>
  );
}

// ------------------------------------------------------------------ asistente

const AUTONOMY = [
  { id: "copilot", title: "Copiloto", text: "El asistente redacta y tú apruebas todo antes de que llegue al cliente. Recomendado las primeras semanas." },
  { id: "semi", title: "Semi-automático", text: "Responde solo dudas informativas. Las citas y los casos delicados esperan tu aprobación." },
  { id: "auto", title: "Autopiloto", text: "Responde y agenda por su cuenta; solo escala lo que las reglas indiquen. Úsalo cuando ya confíes en él." },
] as const;

const TIER_TEXT: Record<string, string> = {
  economico: "Rápido y de bajo costo. Suficiente para preguntas frecuentes y agenda.",
  balanceado: "Mejor redacción y criterio, a un costo moderado.",
  premium: "El más capaz, para conversaciones difíciles. Cuesta bastante más.",
};

function AgentTab({ config, editable, reload }: TabProps) {
  const panel = usePanel();
  const a = config.agent;
  const saver = useSaver(reload);
  const [f, setF] = useState({
    assistantName: a?.assistantName ?? "Asistente",
    tone: a?.tone ?? "cálido y profesional",
    formality: a?.formality ?? "usted",
    autonomy: a?.autonomy ?? "copilot",
    tier: a && a.tier !== "personalizado" ? a.tier : "economico",
    escalationRules: (a?.escalationRules ?? []).join("\n"),
    forbiddenTopics: (a?.forbiddenTopics ?? []).join("\n"),
  });

  function submit() {
    if (f.autonomy === "auto" && a?.autonomy !== "auto" && !window.confirm("Con el autopiloto el asistente responde y agenda citas sin que nadie lo revise. ¿Activarlo?")) return;
    void saver.run("agent", "agent", {
      ...f,
      escalationRules: lines(f.escalationRules),
      forbiddenTopics: lines(f.forbiddenTopics),
    });
  }

  return (
    <div className="space-y-4">
      {!a && <Alert tone="amber">Este negocio aún no tiene un asistente configurado: al guardar se crea.</Alert>}
      <Card title="Cuánta libertad tiene" hint="Es la decisión más importante: define qué llega al cliente sin que lo veas.">
        <div className="space-y-2">
          {AUTONOMY.map((o) => (
            <label key={o.id} className={cx("flex cursor-pointer gap-3 rounded-xl p-3 ring-1", f.autonomy === o.id ? "bg-teal-50 ring-teal-600" : "ring-slate-200 hover:bg-slate-50")}>
              <input type="radio" name="autonomy" className="mt-1 accent-teal-700" checked={f.autonomy === o.id} disabled={!editable} onChange={() => setF((p) => ({ ...p, autonomy: o.id }))} />
              <span>
                <span className="block font-medium text-slate-900">{o.title}</span>
                <span className="block text-sm text-slate-500">{o.text}</span>
              </span>
            </label>
          ))}
        </div>
      </Card>

      <Card title="Personalidad">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre del asistente"><input className={field} value={f.assistantName} onChange={(e) => setF((p) => ({ ...p, assistantName: e.target.value }))} disabled={!editable} maxLength={40} /></Field>
          <Field label="Trato">
            <select className={field} value={f.formality} onChange={(e) => setF((p) => ({ ...p, formality: e.target.value as "tu" | "usted" }))} disabled={!editable}>
              <option value="usted">De usted</option>
              <option value="tu">De tú</option>
            </select>
          </Field>
          <Field label="Tono" className="sm:col-span-2"><input className={field} value={f.tone} onChange={(e) => setF((p) => ({ ...p, tone: e.target.value }))} disabled={!editable} placeholder="cálido y profesional" /></Field>
        </div>
      </Card>

      <Card title="Calidad de la inteligencia artificial">
        {panel.llmMode === "free" && <Alert tone="amber">Ahora mismo el sistema usa modelos <strong>gratuitos de prueba</strong> y este nivel no se aplica. Aun así queda guardado para cuando se active la IA de pago.</Alert>}
        <Field label="Nivel" hint={TIER_TEXT[f.tier]}>
          <select className={field} value={f.tier} onChange={(e) => setF((p) => ({ ...p, tier: e.target.value as "economico" | "balanceado" | "premium" }))} disabled={!editable}>
            <option value="economico">Económico</option>
            <option value="balanceado">Balanceado</option>
            <option value="premium">Premium</option>
          </select>
        </Field>
      </Card>

      <Card title="Reglas" hint="Una por renglón.">
        <Field label="Pasar a una persona siempre que…"><textarea className={field} rows={4} value={f.escalationRules} onChange={(e) => setF((p) => ({ ...p, escalationRules: e.target.value }))} disabled={!editable} placeholder={"quejas\ndescuentos\nfacturas"} /></Field>
        <Field label="Temas que el asistente nunca debe tocar"><textarea className={field} rows={3} value={f.forbiddenTopics} onChange={(e) => setF((p) => ({ ...p, forbiddenTopics: e.target.value }))} disabled={!editable} placeholder="diagnósticos" /></Field>
      </Card>

      <NoticeBox notice={saver.notice} />
      {editable && <Button onClick={submit} loading={saver.busy === "agent"}>Guardar cambios</Button>}
    </div>
  );
}

// ------------------------------------------------------------------ servicios

type Svc = Config["services"][number];

function ServicesTab({ config, editable, reload }: TabProps) {
  const saver = useSaver(reload);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const money = (p: number | null) => (p === null ? "a valorar" : `$${p.toLocaleString("es-MX")} MXN`);

  return (
    <div className="space-y-3">
      <NoticeBox notice={saver.notice} />
      {config.services.map((s) =>
        editing === s.id ? (
          <ServiceForm key={s.id} initial={s} staff={config.staff} saver={saver} onClose={() => setEditing(null)} />
        ) : (
          <div key={s.id} className={cx("flex flex-wrap items-center gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200", !s.active && "opacity-60")}>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-slate-900">{s.name} {!s.active && <Badge tone="slate">Desactivado</Badge>} {s.requiresDeposit && <Badge tone="amber">Anticipo</Badge>}</p>
              <p className="text-sm text-slate-500">{s.durationMin} min · {money(s.price)} · {s.staffIds.length === 0 ? "sin especialista asignado" : `${s.staffIds.length} especialista(s)`}</p>
            </div>
            {editable && (
              <div className="flex gap-2">
                <Button variant="secondary" className="px-3 py-1.5" onClick={() => setEditing(s.id)}>Editar</Button>
                <Button variant="ghost" className="px-3 py-1.5" loading={saver.busy === s.id} onClick={() => saver.run(s.id, "service-active", { id: s.id, active: !s.active }, s.active ? "Servicio desactivado ✓" : "Servicio activado ✓")}>
                  {s.active ? "Desactivar" : "Activar"}
                </Button>
              </div>
            )}
          </div>
        ),
      )}
      {config.services.length === 0 && <Alert tone="amber">Aún no hay servicios: el asistente no tiene qué ofrecer ni agendar.</Alert>}
      {editing === "new" ? (
        <ServiceForm initial={null} staff={config.staff} saver={saver} onClose={() => setEditing(null)} />
      ) : (
        editable && <Button onClick={() => setEditing("new")}>+ Nuevo servicio</Button>
      )}
    </div>
  );
}

function ServiceForm({ initial, staff, saver, onClose }: { initial: Svc | null; staff: Config["staff"]; saver: ReturnType<typeof useSaver>; onClose: () => void }) {
  const [f, setF] = useState({
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    durationMin: String(initial?.durationMin ?? 30),
    bufferMin: String(initial?.bufferMin ?? 10),
    price: initial?.price == null ? "" : String(initial.price),
    requiresDeposit: initial?.requiresDeposit ?? false,
    active: initial?.active ?? true,
    staffIds: initial?.staffIds ?? [],
  });
  const toggle = (id: string) => setF((p) => ({ ...p, staffIds: p.staffIds.includes(id) ? p.staffIds.filter((x) => x !== id) : [...p.staffIds, id] }));

  async function submit() {
    const ok = await saver.run("svc-form", "service", {
      ...(initial ? { id: initial.id } : {}),
      name: f.name,
      description: f.description,
      durationMin: Number(f.durationMin),
      bufferMin: Number(f.bufferMin),
      price: f.price.trim() === "" ? null : Number(f.price),
      requiresDeposit: f.requiresDeposit,
      active: f.active,
      staffIds: f.staffIds,
    });
    if (ok) onClose();
  }

  return (
    <Card title={initial ? `Editar: ${initial.name}` : "Nuevo servicio"}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nombre" className="sm:col-span-2"><input className={field} value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} /></Field>
        <Field label="Descripción (opcional)" className="sm:col-span-2"><input className={field} value={f.description} onChange={(e) => setF((p) => ({ ...p, description: e.target.value }))} maxLength={200} /></Field>
        <Field label="Duración (minutos)"><input className={field} type="number" min={5} max={480} value={f.durationMin} onChange={(e) => setF((p) => ({ ...p, durationMin: e.target.value }))} /></Field>
        <Field label="Tiempo entre citas (minutos)" hint="Limpieza o preparación después del servicio."><input className={field} type="number" min={0} max={120} value={f.bufferMin} onChange={(e) => setF((p) => ({ ...p, bufferMin: e.target.value }))} /></Field>
        <Field label="Precio en pesos" hint="Déjalo vacío si depende de una valoración."><input className={field} inputMode="decimal" value={f.price} onChange={(e) => setF((p) => ({ ...p, price: e.target.value }))} placeholder="600" /></Field>
      </div>
      <div className="flex flex-wrap gap-5 text-sm text-slate-700">
        <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-teal-700" checked={f.requiresDeposit} onChange={(e) => setF((p) => ({ ...p, requiresDeposit: e.target.checked }))} /> Requiere anticipo</label>
        <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-teal-700" checked={f.active} onChange={(e) => setF((p) => ({ ...p, active: e.target.checked }))} /> Activo (se ofrece a los clientes)</label>
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-slate-700">Quién lo realiza</p>
        {staff.length === 0 ? <p className="text-sm text-slate-500">Primero agrega especialistas en la pestaña Equipo.</p> : (
          <div className="flex flex-wrap gap-2">
            {staff.filter((m) => m.active || f.staffIds.includes(m.id)).map((m) => (
              <label key={m.id} className={cx("flex cursor-pointer items-center gap-2 rounded-full px-3 py-1 text-sm ring-1", f.staffIds.includes(m.id) ? "bg-teal-50 ring-teal-600" : "ring-slate-300")}>
                <input type="checkbox" className="accent-teal-700" checked={f.staffIds.includes(m.id)} onChange={() => toggle(m.id)} /> {m.name}
              </label>
            ))}
          </div>
        )}
      </div>
      <NoticeBox notice={saver.notice} />
      <div className="flex gap-2">
        <Button onClick={submit} loading={saver.busy === "svc-form"}>Guardar</Button>
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
      </div>
    </Card>
  );
}

// --------------------------------------------------------------------- equipo

function TeamTab({ config, editable, reload }: TabProps) {
  const saver = useSaver(reload);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const name = (id: string) => config.services.find((s) => s.id === id)?.name ?? "?";

  return (
    <div className="space-y-3">
      <NoticeBox notice={saver.notice} />
      {config.staff.map((m) =>
        editing === m.id ? (
          <StaffForm key={m.id} initial={m} services={config.services} saver={saver} onClose={() => setEditing(null)} />
        ) : (
          <div key={m.id} className={cx("flex flex-wrap items-center gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200", !m.active && "opacity-60")}>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-slate-900">{m.name} {m.roleLabel && <span className="font-normal text-slate-500">· {m.roleLabel}</span>} {!m.active && <Badge tone="slate">Inactivo</Badge>}</p>
              <p className="text-sm text-slate-500">
                {m.serviceIds.length ? m.serviceIds.map(name).join(", ") : "Sin servicios asignados"} · {m.ownHours ? "horario propio" : "sigue el horario del negocio"}
              </p>
            </div>
            {editable && <Button variant="secondary" className="px-3 py-1.5" onClick={() => setEditing(m.id)}>Editar</Button>}
          </div>
        ),
      )}
      {config.staff.length === 0 && <Alert tone="amber">Aún no hay especialistas: sin ellos no se puede agendar.</Alert>}
      {editing === "new" ? <StaffForm initial={null} services={config.services} saver={saver} onClose={() => setEditing(null)} /> : editable && <Button onClick={() => setEditing("new")}>+ Nuevo especialista</Button>}
    </div>
  );
}

function StaffForm({ initial, services, saver, onClose }: { initial: Config["staff"][number] | null; services: Config["services"]; saver: ReturnType<typeof useSaver>; onClose: () => void }) {
  const [f, setF] = useState({ name: initial?.name ?? "", roleLabel: initial?.roleLabel ?? "", active: initial?.active ?? true, serviceIds: initial?.serviceIds ?? [] });
  const toggle = (id: string) => setF((p) => ({ ...p, serviceIds: p.serviceIds.includes(id) ? p.serviceIds.filter((x) => x !== id) : [...p.serviceIds, id] }));

  async function submit() {
    const ok = await saver.run("staff-form", "staff", { ...(initial ? { id: initial.id } : {}), ...f });
    if (ok) onClose();
  }
  return (
    <Card title={initial ? `Editar: ${initial.name}` : "Nuevo especialista"}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nombre"><input className={field} value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} /></Field>
        <Field label="Puesto (opcional)"><input className={field} value={f.roleLabel} onChange={(e) => setF((p) => ({ ...p, roleLabel: e.target.value }))} placeholder="Odontóloga general" /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" className="h-4 w-4 accent-teal-700" checked={f.active} onChange={(e) => setF((p) => ({ ...p, active: e.target.checked }))} /> Activo (recibe citas)</label>
      <div>
        <p className="mb-1 text-sm font-medium text-slate-700">Servicios que realiza</p>
        <div className="flex flex-wrap gap-2">
          {services.filter((s) => s.active || f.serviceIds.includes(s.id)).map((s) => (
            <label key={s.id} className={cx("flex cursor-pointer items-center gap-2 rounded-full px-3 py-1 text-sm ring-1", f.serviceIds.includes(s.id) ? "bg-teal-50 ring-teal-600" : "ring-slate-300")}>
              <input type="checkbox" className="accent-teal-700" checked={f.serviceIds.includes(s.id)} onChange={() => toggle(s.id)} /> {s.name}
            </label>
          ))}
        </div>
      </div>
      <NoticeBox notice={saver.notice} />
      <div className="flex gap-2">
        <Button onClick={submit} loading={saver.busy === "staff-form"}>Guardar</Button>
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
      </div>
    </Card>
  );
}

// -------------------------------------------------------------------- horarios

type Window = { weekday: number; opens: string; closes: string };

function WindowsEditor({ windows, onChange, disabled }: { windows: Window[]; onChange: (w: Window[]) => void; disabled: boolean }) {
  const update = (idx: number, patch: Partial<Window>) => onChange(windows.map((w, i) => (i === idx ? { ...w, ...patch } : w)));
  return (
    <div className="space-y-3">
      {DAYS.map((d) => {
        const rows = windows.map((w, i) => ({ w, i })).filter((r) => r.w.weekday === d.weekday);
        return (
          <div key={d.key} className="flex flex-wrap items-start gap-3">
            <p className="w-24 pt-2 text-sm font-medium text-slate-700">{d.label}</p>
            <div className="space-y-1.5">
              {rows.length === 0 && <p className="pt-2 text-sm text-slate-400">Cerrado</p>}
              {rows.map(({ w, i }) => (
                <div key={i} className="flex items-center gap-2 text-sm text-slate-500">
                  <input type="time" className={cx(field, "w-28")} value={w.opens} disabled={disabled} onChange={(e) => update(i, { opens: e.target.value })} />
                  a
                  <input type="time" className={cx(field, "w-28")} value={w.closes} disabled={disabled} onChange={(e) => update(i, { closes: e.target.value })} />
                  {!disabled && <button className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600" onClick={() => onChange(windows.filter((_, k) => k !== i))} aria-label="Quitar horario">✕</button>}
                </div>
              ))}
              {!disabled && (
                <button className="text-sm font-medium text-teal-700 hover:underline" onClick={() => onChange([...windows, { weekday: d.weekday, opens: rows.length ? rows[rows.length - 1]!.w.closes : "09:00", closes: "19:00" }])}>
                  + {rows.length ? "Otro horario (descanso)" : "Abrir este día"}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HoursTab({ config, editable, reload }: TabProps) {
  const saver = useSaver(reload);
  const [scope, setScope] = useState<string>("business");
  const staffId = scope === "business" ? null : scope;
  const member = config.staff.find((m) => m.id === scope);

  const stored = useMemo(
    () => config.hours.filter((h) => h.staffId === staffId).map((h) => ({ weekday: h.weekday, opens: h.opens, closes: h.closes })),
    [config.hours, staffId],
  );
  const [windows, setWindows] = useState<Window[]>(stored);
  useEffect(() => setWindows(stored), [stored]);

  const [holiday, setHoliday] = useState({ date: "", reason: "", scope: "business" });
  const nameOf = (id: string | null) => (id ? (config.staff.find((m) => m.id === id)?.name ?? "?") : "Todo el negocio");

  return (
    <div className="space-y-4">
      <Card title="Horario de citas" hint="Cuándo se pueden agendar citas. El asistente solo ofrece horarios dentro de este horario.">
        <Field label="¿De quién?">
          <select className={field} value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="business">Horario general del negocio</option>
            {config.staff.map((m) => <option key={m.id} value={m.id}>{m.name} {m.ownHours ? "(horario propio)" : ""}</option>)}
          </select>
        </Field>
        {member && !member.ownHours && windows.length === 0 && (
          <Alert tone="sky">{member.name} sigue el horario general del negocio. Si defines horas aquí, solo trabajará en ellas (siempre dentro del horario del negocio).</Alert>
        )}
        <WindowsEditor windows={windows} onChange={setWindows} disabled={!editable} />
        <NoticeBox notice={saver.notice} />
        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button loading={saver.busy === "hours"} onClick={() => saver.run("hours", "hours", { staffId, windows })}>Guardar horario</Button>
            {member?.ownHours && (
              <Button variant="secondary" onClick={() => window.confirm(`¿Quitar el horario propio de ${member.name}? Volverá a seguir el del negocio.`) && saver.run("hours", "hours", { staffId, windows: [] })}>
                Volver al horario del negocio
              </Button>
            )}
          </div>
        )}
      </Card>

      <Card title="Días libres y festivos" hint="No se ofrecen citas esos días.">
        <ul className="divide-y divide-slate-100">
          {config.holidays.length === 0 && <li className="py-2 text-sm text-slate-500">No hay días libres próximos.</li>}
          {config.holidays.map((h) => (
            <li key={h.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span><strong className="tabular-nums">{h.date}</strong> · {h.reason || "Sin motivo"} <span className="text-slate-400">· {nameOf(h.staffId)}</span></span>
              {editable && <button className="text-rose-600 hover:underline" onClick={() => saver.run(h.id, "holiday-remove", { id: h.id }, "Día libre quitado ✓")}>Quitar</button>}
            </li>
          ))}
        </ul>
        {editable && (
          <div className="grid gap-3 sm:grid-cols-4">
            <input type="date" className={field} value={holiday.date} onChange={(e) => setHoliday((p) => ({ ...p, date: e.target.value }))} />
            <input className={cx(field, "sm:col-span-1")} placeholder="Motivo (opcional)" value={holiday.reason} onChange={(e) => setHoliday((p) => ({ ...p, reason: e.target.value }))} />
            <select className={field} value={holiday.scope} onChange={(e) => setHoliday((p) => ({ ...p, scope: e.target.value }))}>
              <option value="business">Todo el negocio</option>
              {config.staff.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <Button variant="secondary" loading={saver.busy === "holiday-add"} disabled={!holiday.date} onClick={async () => {
              const ok = await saver.run("holiday-add", "holiday-add", { date: holiday.date, reason: holiday.reason, staffId: holiday.scope === "business" ? null : holiday.scope }, "Día libre agregado ✓");
              if (ok) setHoliday({ date: "", reason: "", scope: "business" });
            }}>Agregar</Button>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- conocimiento

function KnowledgeTab({ config, editable, reload }: TabProps) {
  const saver = useSaver(reload);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [f, setF] = useState({ title: "", text: "" });

  function open(id: string | "new") {
    const doc = config.docs.find((d) => d.id === id);
    setF({ title: doc?.title ?? "", text: doc?.text ?? "" });
    setEditing(id);
    saver.clear();
  }
  async function submit() {
    const ok = await saver.run("doc", "doc", { ...(editing && editing !== "new" ? { id: editing } : {}), ...f });
    if (ok) setEditing(null);
  }

  return (
    <div className="space-y-3">
      <Alert tone="sky">Aquí escribes lo que el asistente puede consultar: preguntas frecuentes, políticas, cuidados posteriores… Escribe <strong>una pregunta con su respuesta por renglón</strong>. Si algo no está aquí, el asistente no lo inventa: lo pasa a una persona.</Alert>
      <NoticeBox notice={editing ? null : saver.notice} />
      {config.docs.map((d) => (
        <div key={d.id} className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-slate-900">{d.title}</p>
            <p className="truncate text-sm text-slate-500">{d.text.slice(0, 110)}</p>
          </div>
          {editable && (
            <div className="flex gap-2">
              <Button variant="secondary" className="px-3 py-1.5" onClick={() => open(d.id)}>Editar</Button>
              <Button variant="danger" className="px-3 py-1.5" onClick={() => window.confirm(`¿Borrar "${d.title}"? El asistente dejará de consultarlo.`) && saver.run(d.id, "doc-remove", { id: d.id }, "Documento borrado ✓")}>Borrar</Button>
            </div>
          )}
        </div>
      ))}
      {config.docs.length === 0 && !editing && <Alert tone="amber">Aún no hay documentos: el asistente solo conoce los servicios, horarios y datos del negocio.</Alert>}
      {editing ? (
        <Card title={editing === "new" ? "Nuevo documento" : "Editar documento"}>
          <Field label="Título"><input className={field} value={f.title} onChange={(e) => setF((p) => ({ ...p, title: e.target.value }))} placeholder="Preguntas frecuentes" /></Field>
          <Field label="Contenido"><textarea className={cx(field, "font-mono")} rows={12} value={f.text} onChange={(e) => setF((p) => ({ ...p, text: e.target.value }))} placeholder={"¿Atienden niños? Sí, a partir de los 4 años.\n¿Aceptan seguros dentales? Trabajamos con reembolso…"} /></Field>
          <NoticeBox notice={saver.notice} />
          <div className="flex gap-2">
            <Button onClick={submit} loading={saver.busy === "doc"}>Guardar</Button>
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancelar</Button>
          </div>
        </Card>
      ) : (
        editable && <Button onClick={() => open("new")}>+ Nuevo documento</Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- plantillas

const TPL_STATUS: Record<string, { text: string; tone: "green" | "amber" | "rose" | "slate" }> = {
  approved: { text: "Aprobada", tone: "green" },
  pending: { text: "En revisión", tone: "amber" },
  rejected: { text: "Rechazada", tone: "rose" },
  paused: { text: "Pausada", tone: "slate" },
  disabled: { text: "Desactivada", tone: "slate" },
};

function TemplatesTab({ config, editable, reload }: TabProps) {
  const saver = useSaver(reload);
  const reminders = config.templates.filter((t) => t.isReminder);
  const approved = reminders.filter((t) => t.status === "approved").length;

  return (
    <div className="space-y-4">
      <Card title="Recordatorios de cita" hint="El sistema avisa al cliente 24 horas y 2 horas antes, con los botones “Confirmo” y “Reagendar”.">
        {reminders.length === 0 ? (
          <Alert tone="amber">Todavía no existen las plantillas de recordatorio. Sin ellas no se puede avisar a los clientes fuera de las 24 horas de una conversación.</Alert>
        ) : approved === reminders.length && reminders.length >= 2 ? (
          <Alert tone="green">Los recordatorios están activos: se envían solos a los clientes con cita.</Alert>
        ) : (
          <Alert tone="amber">Los recordatorios saldrán cuando WhatsApp apruebe las plantillas ({approved} de {Math.max(reminders.length, 2)} aprobadas). La revisión suele tardar de minutos a unas horas.</Alert>
        )}
        <ul className="divide-y divide-slate-100">
          {config.templates.map((t) => {
            const s = TPL_STATUS[t.status] ?? { text: t.status, tone: "slate" as const };
            return (
              <li key={t.id} className="space-y-1 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-mono text-sm text-slate-800">{t.name} <span className="text-slate-400">[{t.language}]</span></p>
                  <Badge tone={s.tone}>{s.text}</Badge>
                </div>
                {t.bodyText && <p className="text-sm text-slate-500">{t.bodyText}</p>}
              </li>
            );
          })}
          {config.templates.length === 0 && <li className="py-2 text-sm text-slate-500">Sin plantillas.</li>}
        </ul>
        <NoticeBox notice={saver.notice} />
        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={saver.busy === "sync"} onClick={() => saver.run("sync", "templates-sync", {}, "Estado actualizado desde WhatsApp ✓")}>Actualizar estado</Button>
            <Button
              loading={saver.busy === "create"}
              onClick={() =>
                window.confirm("Se enviarán a WhatsApp (Meta) las plantillas de recordatorio de 24 h y 2 h para su revisión. Quedarán registradas en tu cuenta de WhatsApp Business. ¿Continuar?") &&
                saver.run("create", "templates-create", {}, "Plantillas enviadas a revisión ✓")
              }
            >
              {reminders.length ? "Crear las que falten" : "Crear plantillas de recordatorio"}
            </Button>
          </div>
        )}
        <p className="text-xs text-slate-500">Los avisos fuera de las 24 horas son mensajes de plantilla y WhatsApp los cobra por mensaje; para enviarlos, la cuenta de WhatsApp Business necesita un método de pago.</p>
      </Card>
    </div>
  );
}
