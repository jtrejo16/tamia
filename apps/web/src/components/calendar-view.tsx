"use client";

import type { CalendarView } from "@empleado/inbox";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { Alert, Badge, Button, Spinner } from "./ui";

type Calendar = Serialized<CalendarView>;

const GC_MESSAGES: Record<string, { tone: "green" | "rose" | "amber"; text: string }> = {
  ok: { tone: "green", text: "Google Calendar conectado ✓. Las citas confirmadas aparecerán en tu calendario en un par de minutos." },
  denied: { tone: "amber", text: "No se conectó: cancelaste o no diste el permiso en Google." },
  invalid: { tone: "rose", text: "La conexión expiró o no era válida. Vuelve a intentarlo." },
  forbidden: { tone: "rose", text: "Solo el dueño del negocio puede conectar el calendario." },
  unavailable: { tone: "amber", text: "Google Calendar todavía no está configurado en el servidor. Contacta a soporte." },
  google_rejected: { tone: "rose", text: "Google rechazó la conexión. Inténtalo de nuevo." },
  google_down: { tone: "rose", text: "Google no respondió. Inténtalo en unos minutos." },
  no_refresh_token: { tone: "rose", text: "Google no entregó el permiso permanente. Vuelve a conectar y acepta todos los permisos." },
};

/** Pestaña "Calendario" de Ajustes: conectar Google Calendar para ver las citas en el calendario del consultorio. */
export function CalendarTab({ editable }: { editable: boolean }) {
  const [state, setState] = useState<{ calendar: Calendar; available: boolean } | null>(null);
  const [notice, setNotice] = useState<{ tone: "green" | "rose" | "amber"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{ ok: true; calendar: Calendar; available: boolean }>("/api/calendar");
    if (res.ok) setState({ calendar: res.calendar, available: res.available });
    else setNotice({ tone: "rose", text: res.message });
  }, []);

  useEffect(() => {
    void load();
    // Al volver de Google: ?tab=calendario&gc=<resultado>
    const gc = new URLSearchParams(window.location.search).get("gc");
    if (gc && GC_MESSAGES[gc]) setNotice(GC_MESSAGES[gc]!);
    if (gc) window.history.replaceState(null, "", "/configuracion?tab=calendario");
  }, [load]);

  async function disconnect() {
    if (!window.confirm("¿Desconectar Google Calendar? Los eventos ya creados se quedan en tu calendario, pero las citas nuevas dejarán de aparecer.")) return;
    setBusy(true);
    const res = await api("/api/calendar/disconnect", { method: "POST" });
    setBusy(false);
    setNotice(res.ok ? { tone: "green", text: "Calendario desconectado." } : { tone: "rose", text: res.message });
    await load();
  }

  if (!state) return <div className="flex justify-center p-10 text-slate-400"><Spinner /></div>;
  const { calendar: c, available } = state;

  return (
    <div className="space-y-4">
      {notice && <Alert tone={notice.tone}><p className="font-medium">{notice.text}</p></Alert>}
      {!available && <Alert tone="amber">Google Calendar todavía no está configurado en el servidor. Contacta a soporte.</Alert>}

      <section className="space-y-3 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-semibold text-slate-900">Google Calendar</h2>
          {!c.connected ? <Badge tone="slate">Sin conectar</Badge> : c.status === "error" ? <Badge tone="rose">Requiere reconectar</Badge> : <Badge tone="green">Conectado</Badge>}
        </div>

        {c.connected ? (
          <>
            <p className="text-sm text-slate-600">
              Cuenta: <strong>{c.accountEmail ?? "—"}</strong>. Cada cita confirmada se crea en tu calendario principal; si se cambia de hora o se cancela, el evento se mueve o se borra solo.
            </p>
            {c.status === "error" && <Alert tone="rose">{c.lastError ?? "Hay que volver a conectar tu calendario."}</Alert>}
            {c.status !== "error" && c.lastError && <Alert tone="amber">{c.lastError}</Alert>}
            {c.lastSyncedAt && <p className="text-xs text-slate-500">Última sincronización: {new Date(c.lastSyncedAt).toLocaleString("es-MX")}.</p>}
          </>
        ) : (
          <p className="text-sm text-slate-600">
            Conecta tu Google Calendar y las citas que confirme el asistente aparecerán en tu calendario (y en tu celular). Solo se escriben eventos de citas; no se leen tus demás eventos.
          </p>
        )}

        {editable ? (
          <div className="flex flex-wrap gap-2">
            {/* Es una navegacion completa (redirige a Google), no una llamada fetch. */}
            <a
              href={available ? "/api/calendar/google/start" : undefined}
              aria-disabled={!available}
              className={`inline-flex items-center rounded-lg px-4 py-2 text-sm font-medium text-white ${available ? "bg-teal-700 hover:bg-teal-800" : "cursor-not-allowed bg-slate-300"}`}
            >
              {c.connected ? "Reconectar con Google" : "Conectar con Google"}
            </a>
            {c.connected && <Button variant="secondary" loading={busy} onClick={disconnect}>Desconectar</Button>}
          </div>
        ) : (
          <p className="text-xs text-slate-500">Solo el dueño del negocio puede conectar o desconectar el calendario.</p>
        )}
      </section>
    </div>
  );
}
