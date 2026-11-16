"use client";

import type { SocialChannelView, SocialCheck } from "@empleado/inbox";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { Alert, Badge, Button, Spinner } from "./ui";

type Channel = Serialized<SocialChannelView>;
type Page = { pageId: string; name: string; instagram: { username: string | null } | null };

const LABEL = { messenger: "Facebook Messenger", instagram: "Instagram" } as const;

const FB_MESSAGES: Record<string, { tone: "rose" | "amber"; text: string }> = {
  denied: { tone: "amber", text: "Cancelaste la autorización en Facebook. No se conectó nada." },
  invalid: { tone: "rose", text: "La autorización expiró o no es válida. Vuelve a intentarlo." },
  forbidden: { tone: "rose", text: "Solo el dueño del negocio puede conectar Messenger e Instagram." },
  unavailable: { tone: "amber", text: "La conexión con Facebook todavía no está configurada en el servidor. Contacta a soporte." },
  no_pages: { tone: "rose", text: "Tu cuenta de Facebook no administra ninguna página. Crea una página (y vincula tu Instagram profesional) y vuelve a intentarlo." },
  meta_rejected: { tone: "rose", text: "Facebook rechazó la autorización. Revisa que aceptaste todos los permisos." },
  meta_unavailable: { tone: "amber", text: "Facebook no respondió. Inténtalo en unos minutos." },
};

/** Pestaña "Messenger e Instagram" de Ajustes: conexión con Iniciar sesión con Facebook. */
export function SocialTab({ editable }: { editable: boolean }) {
  const [data, setData] = useState<{ available: boolean; channels: Channel[] } | null>(null);
  const [pages, setPages] = useState<Page[] | null>(null);
  const [choice, setChoice] = useState<{ pageId: string; messenger: boolean; instagram: boolean } | null>(null);
  const [notice, setNotice] = useState<{ tone: "green" | "rose" | "amber"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [checks, setChecks] = useState<SocialCheck[] | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ ok: true; available: boolean; channels: Channel[] }>("/api/channel/social");
    if (res.ok) setData(res);
    else setNotice({ tone: "rose", text: res.message });
  }, []);

  useEffect(() => {
    void load();
    // Al volver de Facebook: ?tab=redes&fb=<resultado>
    const fb = new URLSearchParams(window.location.search).get("fb");
    if (fb === "pick") {
      void (async () => {
        const res = await api<{ ok: true; pages: Page[] }>("/api/channel/facebook/pages");
        if (res.ok && res.pages.length > 0) {
          setPages(res.pages);
          const first = res.pages[0]!;
          setChoice({ pageId: first.pageId, messenger: true, instagram: Boolean(first.instagram) });
        } else setNotice({ tone: "amber", text: "La autorización venció. Vuelve a conectar." });
      })();
    } else if (fb && FB_MESSAGES[fb]) setNotice(FB_MESSAGES[fb]!);
    if (fb) window.history.replaceState(null, "", "/configuracion?tab=redes");
  }, [load]);

  async function connect() {
    if (!choice) return;
    setBusy("connect");
    const res = await api<{ ok: true; connected: string[] }>("/api/channel/facebook/select", { method: "POST", body: choice });
    setBusy(null);
    if (!res.ok) {
      setNotice({ tone: "rose", text: res.message });
      return;
    }
    setPages(null);
    setChoice(null);
    setNotice({ tone: "green", text: `Conectado: ${res.connected.map((t) => LABEL[t as keyof typeof LABEL]).join(" y ")} ✓` });
    await load();
  }

  async function check() {
    setBusy("check");
    setChecks(null);
    const res = await api<{ ok: true; checks: SocialCheck[] }>("/api/channel/social/check", { method: "POST" });
    setBusy(null);
    if (res.ok) setChecks(res.checks);
    else setNotice({ tone: "rose", text: res.message });
  }

  async function disconnect(type: string) {
    if (!window.confirm(`¿Desconectar ${LABEL[type as keyof typeof LABEL]}?\n\nSe borra la clave guardada y el asistente dejará de recibir y enviar mensajes por esa red.`)) return;
    setBusy(type);
    const res = await api("/api/channel/social/disconnect", { method: "POST", body: { type } });
    setBusy(null);
    setNotice(res.ok ? { tone: "green", text: "Desconectado." } : { tone: "rose", text: res.message });
    await load();
  }

  if (!data) return <div className="flex justify-center p-10 text-slate-400"><Spinner /></div>;
  const selected = pages?.find((p) => p.pageId === choice?.pageId);

  return (
    <div className="space-y-4">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 className="font-semibold text-slate-900">Redes conectadas</h2>
        <ul className="mt-2 divide-y divide-slate-100">
          {data.channels.map((c) => (
            <li key={c.type} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-900">{LABEL[c.type]} {c.hasToken && c.status === "active" ? <Badge tone="green">Conectado</Badge> : c.status === "error" ? <Badge tone="rose">Reconectar</Badge> : <Badge tone="slate">Pausado</Badge>}</p>
                <p className="text-sm text-slate-500">{c.name}{c.handle ? ` · @${c.handle}` : ""}</p>
              </div>
              {editable && c.hasToken && <Button variant="danger" className="px-2.5 py-1 text-xs" loading={busy === c.type} onClick={() => disconnect(c.type)}>Desconectar</Button>}
            </li>
          ))}
          {data.channels.length === 0 && <li className="py-2 text-sm text-slate-500">Todavía no has conectado Messenger ni Instagram.</li>}
        </ul>
        {editable && data.channels.some((c) => c.hasToken) && (
          <div className="mt-3 space-y-2">
            <Button variant="secondary" loading={busy === "check"} onClick={check}>Comprobar conexión con Meta</Button>
            {checks?.map((c) => (
              <Alert key={c.type} tone={c.problems.length === 0 ? "green" : "amber"}>
                <p className="font-medium">{LABEL[c.type]}: {c.problems.length === 0 ? "todo en orden ✓" : "hay algo que arreglar"}</p>
                <p className="text-xs">Clave: {c.tokenValid ? "válida" : "no válida"} · App suscrita a la página: {c.subscribed ? `sí (${c.fields.join(", ") || "sin campos"})` : "no"}</p>
                {c.problems.length > 0 && <ul className="mt-1 list-disc pl-5">{c.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
              </Alert>
            ))}
            {checks && checks.length === 0 && <Alert tone="amber">No hay redes con clave guardada para comprobar.</Alert>}
          </div>
        )}
      </section>

      {pages && choice && (
        <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-teal-600">
          <h2 className="font-semibold text-slate-900">Elige qué conectar</h2>
          <label className="block text-sm font-medium text-slate-700">Página de Facebook
            <select
              className="mt-1 w-full rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-slate-300"
              value={choice.pageId}
              onChange={(e) => {
                const p = pages.find((x) => x.pageId === e.target.value)!;
                setChoice({ pageId: p.pageId, messenger: true, instagram: Boolean(p.instagram) });
              }}
            >
              {pages.map((p) => <option key={p.pageId} value={p.pageId}>{p.name}</option>)}
            </select>
          </label>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={choice.messenger} onChange={(e) => setChoice({ ...choice, messenger: e.target.checked })} /> Facebook Messenger de esta página</label>
            <label className={`flex items-center gap-2 ${selected?.instagram ? "" : "text-slate-400"}`}>
              <input type="checkbox" disabled={!selected?.instagram} checked={choice.instagram && Boolean(selected?.instagram)} onChange={(e) => setChoice({ ...choice, instagram: e.target.checked })} />
              {selected?.instagram ? `Instagram${selected.instagram.username ? ` @${selected.instagram.username}` : ""}` : "Instagram (esta página no tiene una cuenta profesional vinculada)"}
            </label>
          </div>
          <div className="flex gap-2">
            <Button onClick={connect} loading={busy === "connect"} disabled={!choice.messenger && !(choice.instagram && selected?.instagram)}>Conectar</Button>
            <Button variant="ghost" onClick={() => { setPages(null); setChoice(null); }}>Cancelar</Button>
          </div>
        </section>
      )}

      {editable && !pages && (
        <section className="space-y-3 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="font-semibold text-slate-900">{data.channels.length ? "Conectar otra página" : "Conectar Messenger e Instagram"}</h2>
          <p className="text-sm text-slate-500">
            Inicia sesión con Facebook, elige tu página y, si la tiene vinculada, tu Instagram profesional. Nosotros nunca vemos tu contraseña; guardamos solo la clave de la página, cifrada.
          </p>
          {data.available ? (
            <a href="/api/channel/facebook/start" className="inline-flex items-center rounded-lg bg-[#1877F2] px-4 py-2 text-sm font-medium text-white hover:opacity-90">Continuar con Facebook</a>
          ) : (
            <Alert tone="amber">La conexión con Facebook todavía no está configurada en el servidor. Contacta a soporte.</Alert>
          )}
        </section>
      )}
      {!editable && <p className="text-sm text-slate-500">Solo el dueño puede conectar o desconectar redes.</p>}
      <p className="text-xs text-slate-500">
        En Messenger e Instagram el asistente responde dentro de las 24 horas siguientes al último mensaje del cliente. Los recordatorios de cita se envían por WhatsApp, por eso el asistente pedirá el teléfono antes de agendar.
      </p>
    </div>
  );
}
