"use client";

import type { ChannelView } from "@empleado/inbox";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { Alert, Badge, Button, Spinner, cx } from "./ui";

type Channel = Serialized<ChannelView>;

const field =
  "w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-900 ring-1 ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600";

/** Pestaña "WhatsApp" de Ajustes: conectar el número del negocio sin usar la terminal. */
export function ChannelTab({ editable }: { editable: boolean }) {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "green" | "rose"; text: string; details?: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ phoneNumberId: "", wabaId: "", accessToken: "" });
  const [replacing, setReplacing] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{ ok: true; channel: Channel }>("/api/channel");
    if (res.ok) setChannel(res.channel);
    else setError(res.message);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function connect() {
    setBusy("connect");
    setNotice(null);
    const res = await api<{ ok: true; displayPhone: string | null; verifiedName: string | null }>("/api/channel/connect", { method: "POST", body: form });
    setBusy(null);
    if (!res.ok) {
      setNotice({ tone: "rose", text: res.message, details: res.details });
      return;
    }
    // La clave ya quedo guardada cifrada en el servidor: se borra de la pantalla.
    setForm({ phoneNumberId: "", wabaId: "", accessToken: "" });
    setReplacing(false);
    setNotice({ tone: "green", text: `WhatsApp conectado${res.displayPhone ? `: ${res.displayPhone}` : ""}${res.verifiedName ? ` (${res.verifiedName})` : ""} ✓` });
    await load();
  }

  async function disconnect() {
    if (!window.confirm("¿Desconectar WhatsApp?\n\nSe borra la clave guardada y el asistente dejará de recibir y enviar mensajes hasta que lo conectes de nuevo.")) return;
    setBusy("disconnect");
    setNotice(null);
    const res = await api("/api/channel/disconnect", { method: "POST" });
    setBusy(null);
    if (!res.ok) setNotice({ tone: "rose", text: res.message });
    else setNotice({ tone: "green", text: "WhatsApp desconectado." });
    await load();
  }

  if (error && !channel) return <Alert>{error}</Alert>;
  if (!channel) return <div className="flex justify-center p-10 text-slate-400"><Spinner /></div>;

  const showForm = editable && (!channel.connected || replacing);

  return (
    <div className="space-y-4">
      {notice && (
        <Alert tone={notice.tone}>
          <p className="font-medium">{notice.text}</p>
          {notice.details && <ul className="mt-1 list-disc pl-5">{notice.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
        </Alert>
      )}

      <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-semibold text-slate-900">Número de WhatsApp</h2>
          {channel.connected ? <Badge tone="green">Conectado</Badge> : channel.hasToken ? <Badge tone="amber">Pausado</Badge> : <Badge tone="slate">Sin conectar</Badge>}
        </div>
        {channel.phoneNumberId && (
          <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {channel.displayPhone && <div><dt className="inline text-slate-500">Número: </dt><dd className="inline font-medium text-slate-900">{channel.displayPhone}</dd></div>}
            <div><dt className="inline text-slate-500">Identificador: </dt><dd className="inline font-mono text-slate-800">{channel.phoneNumberId}</dd></div>
            {channel.wabaId && <div><dt className="inline text-slate-500">Cuenta de WhatsApp Business: </dt><dd className="inline font-mono text-slate-800">{channel.wabaId}</dd></div>}
            {channel.qualityRating && <div><dt className="inline text-slate-500">Calidad: </dt><dd className="inline text-slate-800">{channel.qualityRating}</dd></div>}
          </dl>
        )}
        {editable && channel.hasToken && !replacing && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setReplacing(true)}>Cambiar número o clave</Button>
            <Button variant="danger" loading={busy === "disconnect"} onClick={disconnect}>Desconectar</Button>
          </div>
        )}
        {!editable && !channel.connected && <p className="mt-3 text-sm text-slate-500">Solo el dueño puede conectar el número de WhatsApp.</p>}
      </section>

      {showForm && (
        <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <div>
            <h2 className="font-semibold text-slate-900">{channel.connected ? "Cambiar número o clave" : "Conectar tu número"}</h2>
            <p className="text-sm text-slate-500">
              Copia estos tres datos de tu cuenta en Meta (WhatsApp → Configuración de la API). Antes de guardar, los comprobamos con WhatsApp.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-700">Identificador del número
              <input className={cx(field, "mt-1 font-mono")} inputMode="numeric" value={form.phoneNumberId} onChange={(e) => setForm((p) => ({ ...p, phoneNumberId: e.target.value }))} placeholder="Phone number ID" autoComplete="off" />
            </label>
            <label className="block text-sm font-medium text-slate-700">Identificador de la cuenta
              <input className={cx(field, "mt-1 font-mono")} inputMode="numeric" value={form.wabaId} onChange={(e) => setForm((p) => ({ ...p, wabaId: e.target.value }))} placeholder="WhatsApp Business Account ID" autoComplete="off" />
            </label>
            <label className="block text-sm font-medium text-slate-700 sm:col-span-2">Clave de acceso permanente
              <input className={cx(field, "mt-1 font-mono")} type="password" value={form.accessToken} onChange={(e) => setForm((p) => ({ ...p, accessToken: e.target.value }))} placeholder="Token de un usuario del sistema" autoComplete="off" spellCheck={false} />
              <span className="mt-1 block text-xs font-normal text-slate-500">Se guarda cifrada y no se vuelve a mostrar. Usa un token permanente de usuario del sistema, no el temporal de 24 horas.</span>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={connect} loading={busy === "connect"} disabled={!form.phoneNumberId.trim() || !form.wabaId.trim() || !form.accessToken.trim()}>
              Comprobar y conectar
            </Button>
            {replacing && <Button variant="ghost" onClick={() => setReplacing(false)}>Cancelar</Button>}
          </div>
        </section>
      )}

      {channel.connected && (
        <Alert tone="sky">
          Siguiente paso: en la pestaña <strong>Plantillas</strong> crea las plantillas de recordatorio. Para recibir mensajes, el webhook de tu aplicación en Meta debe apuntar a nuestro servidor (te lo configuramos al darte de alta).
        </Alert>
      )}
    </div>
  );
}
