"use client";

import type { CallView, VoiceSettingsView } from "@empleado/inbox";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, makeFormatters, usePolling } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { usePanel } from "./panel-context";
import { Alert, Badge, Button, EmptyState, Spinner, cx } from "./ui";

type Call = Serialized<CallView>;
type Settings = Serialized<VoiceSettingsView>;
type VoiceOption = { id: string; name: string; provider?: string; gender?: string; accent?: string; previewUrl?: string };

const field =
  "w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-900 ring-1 ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600";

const duration = (s: number | null) => (s === null ? "—" : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);
const SENTIMENT: Record<string, string> = { Positive: "😊", Neutral: "😐", Negative: "😟" };

/** Pantalla "Llamadas": historial del asistente telefonico, con resumen y enlace a la transcripcion. */
export function CallsView() {
  const panel = usePanel();
  const fmt = makeFormatters(panel.timezone);
  const { data, error, loading } = usePolling<{ ok: true; items: Call[] }>("/api/calls", 15000);
  const now = new Date();

  return (
    <div className="mx-auto h-full max-w-4xl space-y-4 overflow-y-auto p-4 sm:p-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Llamadas</h1>
        <p className="text-sm text-slate-500">Lo que atendió tu asistente telefónico. Abre una llamada para leer la conversación completa.</p>
      </div>
      {error && <Alert>{error.message}</Alert>}
      {loading && !data && <div className="flex justify-center p-10 text-slate-400"><Spinner /></div>}
      {data && data.items.length === 0 && (
        <EmptyState title="Todavía no hay llamadas" hint="Cuando alguien llame al número del asistente, aparecerá aquí. Configúralo en Ajustes → Llamadas." />
      )}
      <ul className="space-y-3">
        {data?.items.map((c) => (
          <li key={c.id} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-slate-900">{c.contactName}</p>
              <Badge tone={c.status === "ongoing" ? "green" : c.status === "failed" ? "rose" : "slate"}>
                {c.status === "ongoing" ? "En curso" : c.status === "failed" ? "Falló" : "Terminada"}
              </Badge>
              <Badge tone="amber">{c.direction === "outbound" ? "Saliente" : "Entrante"}</Badge>
              {c.sentiment && <span title={c.sentiment}>{SENTIMENT[c.sentiment] ?? ""}</span>}
              <span className="ml-auto text-xs text-slate-500">
                {c.startedAt ? `${fmt.dayLabel(c.startedAt, now)} ${fmt.time(c.startedAt)}` : ""} · {duration(c.durationSeconds)}
              </span>
            </div>
            {c.phone && <p className="text-xs text-slate-500">{c.phone}</p>}
            {c.summary ? <p className="mt-2 text-sm text-slate-700">{c.summary}</p> : c.status !== "ongoing" && <p className="mt-2 text-sm text-slate-400">Sin resumen todavía.</p>}
            {c.conversationId && (
              <Link href={`/bandeja?c=${c.conversationId}`} className="mt-2 inline-block text-sm font-medium text-teal-700 hover:underline">
                Ver conversación
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Pestaña "Llamadas" de Ajustes: activar el asistente telefonico y sincronizarlo con Retell. */
export function VoiceTab({ editable }: { editable: boolean }) {
  const [s, setS] = useState<Settings | null>(null);
  const [form, setForm] = useState({ enabled: false, allowBooking: false, greeting: "", voiceId: "", phoneNumber: "", transferNumber: "" });
  const [notice, setNotice] = useState<{ tone: "green" | "rose" | "amber"; text: string; details?: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voicesError, setVoicesError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ ok: true; settings: Settings }>("/api/voice/settings");
    if (res.ok) {
      setS(res.settings);
      setForm({ enabled: res.settings.enabled, allowBooking: res.settings.allowBooking, greeting: res.settings.greeting, voiceId: res.settings.voiceId, phoneNumber: res.settings.phoneNumber, transferNumber: res.settings.transferNumber });
    } else setNotice({ tone: "rose", text: res.message });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Voces disponibles en Retell (desplegable). Las que suenan en espanol/mexicano van primero.
  useEffect(() => {
    void (async () => {
      const res = await api<{ ok: true; voices: VoiceOption[] }>("/api/voice/voices");
      if (!res.ok) {
        setVoicesError(res.message);
        return;
      }
      const rank = (v: VoiceOption) => (/mex|latin|spanish|espa/i.test(`${v.accent ?? ""} ${v.name}`) ? 0 : 1);
      setVoices([...res.voices].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)));
    })();
  }, []);
  const selectedVoice = voices.find((v) => v.id === form.voiceId);

  async function save(then?: "sync") {
    setBusy("save");
    setNotice(null);
    const res = await api("/api/voice/settings", { method: "POST", body: form });
    if (!res.ok) {
      setBusy(null);
      setNotice({ tone: "rose", text: res.message, details: res.details });
      return;
    }
    if (then === "sync") {
      setBusy("sync");
      const sync = await api<{ ok: true; agentId: string }>("/api/voice/sync", { method: "POST" });
      setNotice(sync.ok ? { tone: "green", text: "Agente sincronizado con Retell ✓. Ahora enlaza tu número a ese agente en Retell (instrucciones abajo)." } : { tone: "rose", text: sync.message });
    } else setNotice({ tone: "green", text: "Guardado ✓" });
    setBusy(null);
    await load();
  }

  if (!s) return <div className="flex justify-center p-10 text-slate-400"><Spinner /></div>;
  const disabled = !editable;

  return (
    <div className="space-y-4">
      {notice && (
        <Alert tone={notice.tone}>
          <p className="font-medium">{notice.text}</p>
          {notice.details && <ul className="mt-1 list-disc pl-5">{notice.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
        </Alert>
      )}
      {!s.retellConfigured && <Alert tone="amber">La telefonía con IA todavía no está configurada en el servidor (falta la clave de Retell). Contacta a soporte.</Alert>}

      <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-semibold text-slate-900">Asistente telefónico</h2>
          {s.synced ? <Badge tone="green">Sincronizado con Retell</Badge> : <Badge tone="slate">Sin sincronizar</Badge>}
        </div>

        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input type="checkbox" disabled={disabled} checked={form.enabled} onChange={(e) => setForm((p) => ({ ...p, enabled: e.target.checked }))} /> Activar el asistente telefónico
        </label>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-1" disabled={disabled} checked={form.allowBooking} onChange={(e) => setForm((p) => ({ ...p, allowBooking: e.target.checked }))} />
          <span><span className="font-medium">Permitir que agende, cambie y cancele citas por teléfono.</span><br />
            <span className="text-slate-500">Si lo dejas apagado, el asistente atiende dudas y toma los datos para que una persona confirme la cita. Si lo enciendes, agenda directo después de que el cliente confirme de viva voz, sin pasar por Aprobaciones.</span></span>
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-700 sm:col-span-2">Saludo (opcional)
            <input className={cx(field, "mt-1")} disabled={disabled} maxLength={300} value={form.greeting} onChange={(e) => setForm((p) => ({ ...p, greeting: e.target.value }))} placeholder="Hola, gracias por llamar a… ¿en qué te puedo ayudar?" />
          </label>
          <div className="block text-sm font-medium text-slate-700">
            <label>Voz
              {voices.length > 0 ? (
                <select className={cx(field, "mt-1")} disabled={disabled} value={form.voiceId} onChange={(e) => setForm((p) => ({ ...p, voiceId: e.target.value }))}>
                  <option value="">— Elige una voz —</option>
                  {form.voiceId && !voices.some((v) => v.id === form.voiceId) && <option value={form.voiceId}>{form.voiceId} (actual)</option>}
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>{[v.name, v.provider, v.gender, v.accent].filter(Boolean).join(" · ")}</option>
                  ))}
                </select>
              ) : (
                <input className={cx(field, "mt-1 font-mono")} disabled={disabled} value={form.voiceId} onChange={(e) => setForm((p) => ({ ...p, voiceId: e.target.value }))} placeholder="Voice ID" />
              )}
            </label>
            {voicesError && <span className="mt-1 block text-xs font-normal text-amber-700">{voicesError} Puedes escribir el identificador a mano.</span>}
            {selectedVoice?.previewUrl && <audio className="mt-2 h-8 w-full" controls preload="none" src={selectedVoice.previewUrl} />}
          </div>
          <label className="block text-sm font-medium text-slate-700">Número de teléfono (para mostrar)
            <input className={cx(field, "mt-1")} disabled={disabled} value={form.phoneNumber} onChange={(e) => setForm((p) => ({ ...p, phoneNumber: e.target.value }))} placeholder="+529981234567" />
          </label>
        </div>

        <label className="block text-sm font-medium text-slate-700">Número de recepción para transferir llamadas (opcional)
          <input className={cx(field, "mt-1")} disabled={disabled} value={form.transferNumber} onChange={(e) => setForm((p) => ({ ...p, transferNumber: e.target.value }))} placeholder="+529981234567" />
          <span className="mt-1 block text-xs font-normal text-slate-500">Si lo pones, cuando el cliente pida hablar con una persona el asistente lo transfiere a este número, <strong>solo dentro del horario de atención</strong> del negocio (Ajustes → Horarios). Fuera de horario toma recado y lo escala. Recuerda volver a sincronizar. La transferencia funciona en llamadas telefónicas, no en la llamada web de prueba.</span>
        </label>

        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={busy === "save"} onClick={() => save()}>Guardar</Button>
            <Button loading={busy === "sync"} disabled={!s.retellConfigured} onClick={() => save("sync")}>Guardar y sincronizar con Retell</Button>
          </div>
        )}
        {s.lastSyncedAt && <p className="text-xs text-slate-500">Última sincronización: {new Date(s.lastSyncedAt).toLocaleString("es-MX")}. Vuelve a sincronizar cada vez que cambies servicios, horarios o estos ajustes.</p>}
      </section>

      <section className="rounded-2xl bg-white p-5 text-sm text-slate-600 shadow-sm ring-1 ring-slate-200">
        <h2 className="mb-2 font-semibold text-slate-900">Cómo recibir llamadas</h2>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Elige una voz del desplegable de arriba (puedes escucharla antes de guardar).</li>
          <li>Pulsa <strong>Guardar y sincronizar</strong>: se crea tu agente en Retell.</li>
          <li>Para <strong>probar sin número</strong>, abre ese agente en Retell y usa la llamada web de prueba.</li>
          <li>Para recibir llamadas reales, enlaza un número telefónico a ese agente en Retell (con Twilio u otro proveedor).</li>
        </ol>
      </section>
    </div>
  );
}
