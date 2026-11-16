"use client";

import type { ConversationDetail, ConversationSummary, MessageView } from "@empleado/inbox";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, makeFormatters, timeLeft, usePolling } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { canAct, usePanel } from "./panel-context";
import { Alert, Avatar, Badge, Button, EmptyState, RichText, Spinner, cx } from "./ui";

type Summary = Serialized<ConversationSummary>;

const CHANNEL_LABEL: Record<string, { label: string; tone: "green" | "sky" | "rose" }> = {
  whatsapp: { label: "WhatsApp", tone: "green" },
  messenger: { label: "Messenger", tone: "sky" },
  instagram: { label: "Instagram", tone: "rose" },
};
const ChannelBadge = ({ channel }: { channel: string }) => {
  const c = CHANNEL_LABEL[channel] ?? CHANNEL_LABEL.whatsapp!;
  return <Badge tone={c.tone}>{c.label}</Badge>;
};
type Detail = Serialized<ConversationDetail>;
type Message = Serialized<MessageView>;
type Filter = "all" | "attention" | "bot" | "human" | "closed";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "Todas" },
  { id: "attention", label: "Atención" },
  { id: "bot", label: "Asistente" },
  { id: "human", label: "Persona" },
  { id: "closed", label: "Cerradas" },
];

function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const STATE_BADGE = {
  bot: <Badge tone="teal">Asistente</Badge>,
  human: <Badge tone="sky">Persona</Badge>,
  closed: <Badge tone="slate">Cerrada</Badge>,
};

export function InboxView() {
  const panel = usePanel();
  const fmt = useMemo(() => makeFormatters(panel.timezone), [panel.timezone]);
  const router = useRouter();
  const selected = useSearchParams().get("c");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const q = useDebounced(query, 300);
  const now = useNow();

  const list = usePolling<{ ok: true; items: Summary[] }>(`/api/conversations?filter=${filter}&q=${encodeURIComponent(q)}`, 4000);
  const items = list.data?.items ?? [];

  const open = (id: string | null) => router.replace(id ? `/bandeja?c=${id}` : "/bandeja", { scroll: false });

  return (
    <div className="flex h-full">
      <section className={cx("w-full flex-col border-r border-slate-200 bg-white lg:flex lg:w-[360px] lg:shrink-0", selected ? "hidden" : "flex")}>
        <div className="space-y-3 border-b border-slate-200 p-4">
          <h1 className="text-lg font-semibold text-slate-900">Bandeja</h1>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por nombre o teléfono"
            className="w-full rounded-lg bg-slate-100 px-3 py-2 text-sm placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
          />
          <div className="flex gap-1.5 overflow-x-auto pb-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={cx(
                  "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  filter === f.id ? "bg-teal-700 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {list.loading && !list.data ? (
            <div className="flex justify-center p-8 text-slate-400"><Spinner /></div>
          ) : list.error && !list.data ? (
            <div className="p-4"><Alert>{list.error.message}</Alert></div>
          ) : items.length === 0 ? (
            <EmptyState
              title={q ? "Sin resultados" : filter === "attention" ? "Nada requiere tu atención" : "Aún no hay conversaciones"}
              hint={q ? "Prueba con otro nombre o número." : "Cuando un cliente escriba por WhatsApp aparecerá aquí."}
            />
          ) : (
            <ul>
              {items.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => open(c.id)}
                    className={cx(
                      "flex w-full items-start gap-3 border-b border-slate-100 px-4 py-3 text-left transition-colors hover:bg-slate-50",
                      selected === c.id && "bg-teal-50 hover:bg-teal-50",
                    )}
                  >
                    <div className="relative">
                      <Avatar name={c.contact.name} />
                      {c.needsAttention && <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full bg-amber-500 ring-2 ring-white" title="Requiere atención" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="truncate font-medium text-slate-900">{c.contact.name}</p>
                        {c.lastMessageAt && <span className="shrink-0 text-xs text-slate-400">{fmt.short(c.lastMessageAt, now)}</span>}
                      </div>
                      <p className="truncate text-sm text-slate-500">
                        {!c.previewFromCustomer && c.preview && <span className="text-slate-400">↩ </span>}
                        {c.preview || "Sin mensajes"}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <ChannelBadge channel={c.channel} />
                        {STATE_BADGE[c.state]}
                        {c.handoff && <Badge tone={c.handoff.urgency === "alta" ? "rose" : "amber"}>{c.handoff.urgency === "alta" ? "Urgente" : "Escalada"}</Badge>}
                        {c.pendingApprovals > 0 && <Badge tone="amber">{c.pendingApprovals} borrador{c.pendingApprovals > 1 ? "es" : ""}</Badge>}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className={cx("min-w-0 flex-1 bg-slate-50 lg:flex", selected ? "flex" : "hidden")}>
        {selected ? (
          <ConversationPane key={selected} id={selected} onBack={() => open(null)} />
        ) : (
          <EmptyState title="Elige una conversación" hint="Aquí verás los mensajes y podrás tomar el control cuando haga falta." />
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ conversacion

function Ticks({ m }: { m: Message }) {
  if (m.direction !== "out") return null;
  switch (m.status) {
    case "queued":
      return <span className="text-slate-400">Enviando…</span>;
    case "sent":
      return <span className="text-slate-400">✓ Enviado</span>;
    case "delivered":
      return <span className="text-slate-400">✓✓ Entregado</span>;
    case "read":
      return <span className="text-sky-500">✓✓ Leído</span>;
    case "failed":
      return <span className="text-rose-600" title={m.error ?? ""}>⚠ No se envió</span>;
    default:
      return null;
  }
}

function ConversationPane({ id, onBack }: { id: string; onBack: () => void }) {
  const panel = usePanel();
  const fmt = useMemo(() => makeFormatters(panel.timezone), [panel.timezone]);
  const now = useNow();
  const detail = usePolling<{ ok: true; conversation: Detail }>(`/api/conversations/${id}`, 3000);
  const c = detail.data?.conversation;

  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const count = c?.messages.length ?? 0;
  useEffect(() => {
    if (stick.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [count, c?.messages.at(-1)?.status]);

  async function act(action: "take" | "release" | "close") {
    if (action === "close" && !window.confirm("¿Cerrar esta conversación? El asistente dejará de atenderla.")) return;
    setBusy(action);
    setError(null);
    const res = await api<{ ok: true }>(`/api/conversations/${id}/${action}`, { method: "POST" });
    if (!res.ok) setError(res.message);
    await detail.reload();
    setBusy(null);
  }

  async function send() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy("send");
    setError(null);
    const res = await api<{ ok: true }>(`/api/conversations/${id}/send`, { method: "POST", body: { text: body } });
    if (res.ok) {
      setText("");
      stick.current = true;
    } else {
      setError(res.message);
    }
    await detail.reload();
    setBusy(null);
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  if (!c) {
    return (
      <div className="flex flex-1 items-center justify-center">
        {detail.error ? (
          <div className="space-y-3 p-6 text-center">
            <Alert>{detail.error.message}</Alert>
            <Button variant="secondary" onClick={onBack}>Volver a la lista</Button>
          </div>
        ) : (
          <Spinner className="h-6 w-6 text-slate-400" />
        )}
      </div>
    );
  }

  const writable = canAct(panel.role);
  const mine = c.state === "human" && c.assignedUserId === panel.userId;
  const left = c.windowOpen ? timeLeft(c.windowClosesAt, now) : null;
  const composerHint = !writable
    ? "Tu rol es de solo lectura."
    : c.state === "closed"
      ? "La conversación está cerrada."
      : c.state === "bot"
        ? "El asistente está atendiendo. Toma el control para escribir tú."
        : !mine
          ? c.assignedUserId
            ? `${c.assignedUserName ?? "Otra persona"} tiene el control de esta conversación.`
            : "Esta conversación espera a una persona. Pulsa “Atender yo” para responder."
          : !c.windowOpen
            ? "Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp solo permite plantillas aprobadas."
            : null;

  let lastDay = "";
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <button onClick={onBack} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden" aria-label="Volver">←</button>
        <Avatar name={c.contact.name} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-slate-900">{c.contact.name}</p>
          <p className="truncate text-xs text-slate-500">
            {c.contact.phone ? `+${c.contact.phone.replace(/\D/g, "")}` : `${CHANNEL_LABEL[c.channel]?.label ?? ""} · sin teléfono`}
            {!c.contact.hasRealName && c.contact.whatsappName ? ` · nombre de ${CHANNEL_LABEL[c.channel]?.label ?? "WhatsApp"}` : ""}
          </p>
        </div>
        <div className="hidden items-center gap-2 sm:flex">
          <ChannelBadge channel={c.channel} />
          {STATE_BADGE[c.state]}
          {c.windowOpen ? <Badge tone="green">Ventana: {left}</Badge> : <Badge tone="slate">Ventana cerrada</Badge>}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
        {/* También en una conversación escalada que espera a una persona (state "human" sin asignar). */}
        {c.state !== "closed" && !mine && (
          <Button onClick={() => act("take")} loading={busy === "take"} disabled={!writable} className="py-1.5">
            {c.state === "bot" ? "Tomar control" : c.assignedUserId ? "Tomar control" : "Atender yo"}
          </Button>
        )}
        {c.state === "human" && (
          <Button variant="secondary" onClick={() => act("release")} loading={busy === "release"} disabled={!writable} className="py-1.5">
            Devolver al asistente
          </Button>
        )}
        {c.state !== "closed" && (
          <Button variant="ghost" onClick={() => act("close")} loading={busy === "close"} disabled={!writable} className="py-1.5">Cerrar</Button>
        )}
        <div className="ml-auto flex items-center gap-2 sm:hidden">
          {c.windowOpen ? <Badge tone="green">{left}</Badge> : <Badge tone="slate">Ventana cerrada</Badge>}
        </div>
      </div>

      {(c.handoff || c.approvals.length > 0) && (
        <div className="space-y-2 border-b border-slate-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          {c.handoff && (
            <p>
              <strong>{c.handoff.urgency === "alta" ? "Urgente: " : "Escalada: "}</strong>
              {c.handoff.reason}
            </p>
          )}
          {c.approvals.length > 0 && (
            <p>
              Hay {c.approvals.length} borrador{c.approvals.length > 1 ? "es" : ""} del asistente por revisar.{" "}
              <Link href="/aprobaciones" className="font-medium underline">Ir a Aprobaciones</Link>
            </p>
          )}
        </div>
      )}

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="scroll-thin min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-4"
      >
        {c.messages.length === 0 && <EmptyState title="Sin mensajes todavía" />}
        {c.messages.map((m) => {
          const day = fmt.dayKey(m.createdAt);
          const separator = day !== lastDay;
          lastDay = day;
          const out = m.direction === "out";
          const human = m.sender === "human";
          return (
            <div key={m.id}>
              {separator && (
                <div className="my-3 flex justify-center">
                  <span className="rounded-full bg-slate-200/70 px-3 py-0.5 text-xs text-slate-600">{fmt.dayLabel(m.createdAt, now)}</span>
                </div>
              )}
              <div className={cx("flex", out ? "justify-end" : "justify-start")}>
                <div
                  className={cx(
                    "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm shadow-sm sm:max-w-[70%]",
                    !out && "rounded-bl-md bg-white text-slate-900",
                    out && !human && "rounded-br-md bg-teal-100 text-teal-950",
                    out && human && "rounded-br-md bg-teal-700 text-white",
                    m.status === "failed" && "ring-2 ring-rose-300",
                  )}
                >
                  {out && <p className={cx("mb-0.5 text-xs font-medium", human ? "text-teal-100" : "text-teal-700")}>{human ? "Equipo" : "Asistente"}</p>}
                  <p className="whitespace-pre-wrap break-words">{m.text ? <RichText text={m.text} /> : <em className="opacity-60">(sin contenido)</em>}</p>
                  <p className={cx("mt-1 flex items-center justify-end gap-2 text-[11px]", out && human ? "text-teal-100" : "text-slate-400")}>
                    <span>{fmt.time(m.createdAt)}</span>
                    <Ticks m={m} />
                  </p>
                  {m.status === "failed" && m.error && <p className="mt-1 text-xs text-rose-700">{m.error}</p>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <footer className="border-t border-slate-200 bg-white p-3">
        {error && <Alert className="mb-2">{error}</Alert>}
        {composerHint ? (
          <p className="rounded-lg bg-slate-100 px-3 py-2.5 text-center text-sm text-slate-600">{composerHint}</p>
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              rows={2}
              maxLength={3800}
              placeholder="Escribe tu respuesta… (Enter envía, Shift+Enter salto de línea)"
              className="max-h-40 min-h-[2.75rem] flex-1 resize-y rounded-xl bg-slate-100 px-3.5 py-2.5 text-sm placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
            <Button onClick={send} loading={busy === "send"} disabled={!text.trim()} className="h-11">Enviar</Button>
          </div>
        )}
      </footer>
    </div>
  );
}
