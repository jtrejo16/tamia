"use client";

import type { PlaygroundTurn } from "@empleado/inbox";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { canAct, usePanel } from "./panel-context";
import { Alert, Badge, Button, RichText, cx } from "./ui";

type Turn = Serialized<PlaygroundTurn>;
interface Line {
  id: number;
  from: "customer" | "assistant";
  text: string;
  turn?: Turn;
}

const newKey = () => `p${crypto.randomUUID().replace(/-/g, "")}`;

const short = (v: unknown, max = 220) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

export function PlaygroundView() {
  const panel = usePanel();
  const [sessionKey, setSessionKey] = useState(newKey);
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const nextId = useRef(1);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Con llaves: un efecto no debe devolver el resultado de scrollIntoView (React espera una funcion de limpieza).
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lines.length, busy]);
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  async function send() {
    const body = text.trim();
    if (!body || busy) return;
    setText("");
    setError(null);
    setLines((l) => [...l, { id: nextId.current++, from: "customer", text: body }]);
    setBusy(true);
    const res = await api<{ ok: true; turn: Turn }>("/api/playground", { method: "POST", body: { text: body, sessionKey } });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const t = res.turn;
    setLines((l) => [
      ...l,
      {
        id: nextId.current++,
        from: "assistant",
        turn: t,
        text: t.text ?? (t.action === "none" ? "(El asistente no responde: la conversación de prueba está en manos de una persona. Empieza una nueva.)" : ""),
      },
    ]);
  }

  const reset = () => {
    setSessionKey(newKey());
    setLines([]);
    setError(null);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Probador</h1>
          <p className="text-sm text-slate-500">Escribe como si fueras un cliente. Usa el mismo asistente que WhatsApp, pero no envía nada afuera.</p>
        </div>
        <Button variant="secondary" onClick={reset} disabled={busy}>Nueva conversación</Button>
      </header>

      {panel.llmMode === "free" && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          Estás usando modelos <strong>gratuitos</strong>: cada respuesta puede tardar hasta un par de minutos y los proveedores pueden registrar lo que escribas. Usa solo datos inventados.
        </div>
      )}

      <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto bg-slate-50 px-4 py-5">
        {lines.length === 0 && (
          <div className="mx-auto max-w-md rounded-2xl bg-white p-6 text-center ring-1 ring-slate-200">
            <p className="font-medium text-slate-800">Prueba cosas como…</p>
            <ul className="mt-2 space-y-1 text-sm text-slate-500">
              <li>“Hola, ¿cuánto cuesta una limpieza?”</li>
              <li>“Quiero una cita el jueves por la tarde”</li>
              <li>“Me duele muchísimo una muela”</li>
              <li>“¿Me ayudas con mi tarea de matemáticas?”</li>
            </ul>
          </div>
        )}

        {lines.map((l) => (
          <div key={l.id} className={cx("flex", l.from === "customer" ? "justify-end" : "justify-start")}>
            <div className="max-w-[88%] sm:max-w-[70%]">
              <div className={cx("rounded-2xl px-3.5 py-2 text-sm shadow-sm", l.from === "customer" ? "rounded-br-md bg-teal-700 text-white" : "rounded-bl-md bg-white text-slate-900")}>
                <p className="whitespace-pre-wrap break-words"><RichText text={l.text} /></p>
              </div>
              {l.turn && <TurnDetails turn={l.turn} />}
            </div>
          </div>
        ))}

        {busy && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-md bg-white px-4 py-3 text-sm text-slate-500 shadow-sm">
              El asistente está pensando… <span className="tabular-nums text-slate-400">{elapsed}s</span>
            </div>
          </div>
        )}
        <div ref={bottom} />
      </div>

      <footer className="border-t border-slate-200 bg-white p-3">
        {error && <Alert className="mb-2">{error}</Alert>}
        {!canAct(panel.role) ? (
          <p className="rounded-lg bg-slate-100 px-3 py-2.5 text-center text-sm text-slate-600">Tu rol es de solo lectura.</p>
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              rows={2}
              maxLength={2000}
              placeholder="Escribe como cliente… (Enter envía)"
              className="max-h-40 min-h-[2.75rem] flex-1 resize-y rounded-xl bg-slate-100 px-3.5 py-2.5 text-sm placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
            <Button onClick={send} loading={busy} disabled={!text.trim()} className="h-11">Enviar</Button>
          </div>
        )}
      </footer>
    </div>
  );
}

function TurnDetails({ turn }: { turn: Turn }) {
  const flags: Array<{ tone: "amber" | "rose" | "sky"; text: string }> = [];
  if (turn.action === "draft") flags.push({ tone: "amber", text: "Modo copiloto: esto sería un borrador que aprobarías en Aprobaciones" });
  if (turn.escalated) flags.push({ tone: "rose", text: "Escalado a una persona" });
  if (turn.failure) flags.push({ tone: "rose", text: `Fallo: ${turn.failure}` });
  if (turn.attachments.length > 0) flags.push({ tone: "sky", text: "Enviaría la ubicación del negocio" });

  return (
    <div className="mt-1.5 space-y-1.5 px-1">
      {flags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {flags.map((f) => <Badge key={f.text} tone={f.tone}>{f.text}</Badge>)}
        </div>
      )}
      {turn.proposedActions.length > 0 && (
        <div className="rounded-lg bg-sky-50 px-2.5 py-1.5 text-xs text-sky-900 ring-1 ring-sky-200">
          Acción propuesta (no se ejecuta hasta aprobar): {turn.proposedActions.map((a) => a.summary).join(" · ")}
        </div>
      )}
      <details className="group text-xs text-slate-500">
        <summary className="cursor-pointer select-none hover:text-slate-700">
          Cómo lo resolvió · {turn.usage.calls} llamada{turn.usage.calls === 1 ? "" : "s"} · {turn.toolTrace.length} herramienta{turn.toolTrace.length === 1 ? "" : "s"}
        </summary>
        <div className="mt-1.5 space-y-1.5 rounded-lg bg-white p-2.5 ring-1 ring-slate-200">
          {turn.toolTrace.length === 0 && <p>Respondió sin usar herramientas.</p>}
          {turn.toolTrace.map((t, i) => (
            <div key={i} className="font-mono">
              <p className="font-semibold text-slate-700">{t.name}</p>
              <p className="break-all text-slate-400">entrada: {short(t.args, 160)}</p>
              <p className="break-all text-slate-600">resultado: {short(t.result)}</p>
            </div>
          ))}
          <p className="border-t border-slate-100 pt-1.5">
            {turn.usage.models.join(", ") || "sin modelo"} · {turn.usage.tokensIn.toLocaleString("es-MX")} tokens de entrada ·{" "}
            {turn.usage.costUsd === 0 ? "sin costo" : `US$${turn.usage.costUsd.toFixed(5)}`}
          </p>
        </div>
      </details>
    </div>
  );
}
