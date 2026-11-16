"use client";

import type { ApprovalView } from "@empleado/inbox";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api, makeFormatters, usePolling } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { canAct, usePanel } from "./panel-context";
import { Alert, Avatar, Badge, Button, EmptyState, Spinner, cx } from "./ui";

type Approval = Serialized<ApprovalView>;

const STATUS_LABEL: Record<string, { text: string; tone: "green" | "sky" | "slate" }> = {
  approved: { text: "Aprobado", tone: "green" },
  edited: { text: "Editado y enviado", tone: "sky" },
  discarded: { text: "Descartado", tone: "slate" },
};

export function ApprovalsView() {
  const panel = usePanel();
  const [tab, setTab] = useState<"pending" | "reviewed">("pending");
  const list = usePolling<{ ok: true; items: Approval[] }>(`/api/approvals?status=${tab}`, 5000);
  const items = list.data?.items ?? [];

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-4 lg:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Aprobaciones</h1>
            <p className="text-sm text-slate-500">Borradores del asistente que esperan tu visto bueno antes de llegar al cliente.</p>
          </div>
          <div className="flex rounded-lg bg-slate-200/70 p-0.5 text-sm">
            {(["pending", "reviewed"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cx("rounded-md px-3 py-1 font-medium", tab === t ? "bg-white text-slate-900 shadow-sm" : "text-slate-600")}
              >
                {t === "pending" ? "Pendientes" : "Revisados"}
              </button>
            ))}
          </div>
        </div>

        {list.loading && !list.data ? (
          <div className="flex justify-center p-10 text-slate-400"><Spinner /></div>
        ) : list.error && !list.data ? (
          <Alert>{list.error.message}</Alert>
        ) : items.length === 0 ? (
          <div className="rounded-2xl bg-white py-16 ring-1 ring-slate-200">
            <EmptyState
              title={tab === "pending" ? "No hay borradores por revisar" : "Todavía no has revisado borradores"}
              hint={tab === "pending" ? "Cuando el asistente trabaje en modo copiloto, sus respuestas aparecerán aquí." : undefined}
            />
          </div>
        ) : tab === "pending" ? (
          items.map((a) => <PendingCard key={a.id} a={a} canAct={canAct(panel.role)} onDone={list.reload} />)
        ) : (
          <ul className="space-y-2">
            {items.map((a) => {
              const s = STATUS_LABEL[a.status] ?? { text: a.status, tone: "slate" as const };
              return (
                <li key={a.id} className="rounded-xl bg-white p-4 text-sm ring-1 ring-slate-200">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="font-medium text-slate-900">{a.contact.name}</p>
                    <Badge tone={s.tone}>{s.text}</Badge>
                  </div>
                  <p className="whitespace-pre-wrap text-slate-600"><span className="font-medium text-slate-500">Borrador: </span>{a.draft}</p>
                  {a.finalText && a.finalText !== a.draft && (
                    <p className="mt-2 whitespace-pre-wrap text-slate-800"><span className="font-medium text-teal-700">Enviado: </span>{a.finalText}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function PendingCard({ a, canAct: allowed, onDone }: { a: Approval; canAct: boolean; onDone: () => Promise<void> }) {
  const panel = usePanel();
  const fmt = useMemo(() => makeFormatters(panel.timezone), [panel.timezone]);
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "discard" | null>(null);
  const [error, setError] = useState<{ message: string; details?: string[] } | null>(null);

  const text = edit ?? a.draft;
  const changed = text.trim() !== a.draft.trim();
  const blocked = a.conversation.state !== "bot" ? "Una persona tiene el control de esta conversación." : !a.conversation.windowOpen ? "Pasaron más de 24 h desde el último mensaje del cliente." : null;

  async function run(kind: "approve" | "discard") {
    if (kind === "discard" && !window.confirm("¿Descartar este borrador? No se enviará nada al cliente.")) return;
    setBusy(kind);
    setError(null);
    const res = await api<{ ok: true }>(`/api/approvals/${a.id}/${kind}`, {
      method: "POST",
      body: kind === "approve" && changed ? { text } : {},
    });
    if (!res.ok) setError({ message: res.message, details: res.details });
    await onDone();
    setBusy(null);
  }

  return (
    <article className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
      <header className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
        <Avatar name={a.contact.name} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-slate-900">{a.contact.name}</p>
          <p className="text-xs text-slate-500">Borrador de {fmt.short(a.createdAt)} · {fmt.time(a.createdAt)}</p>
        </div>
        <Link href={`/bandeja?c=${a.conversation.id}`} className="text-sm font-medium text-teal-700 hover:underline">Ver conversación</Link>
      </header>

      {a.context.length > 0 && (
        <div className="space-y-1.5 border-b border-slate-100 bg-slate-50 px-4 py-3">
          {a.context.map((m) => (
            <p key={m.id} className="text-sm">
              <span className={cx("mr-1.5 font-medium", m.direction === "in" ? "text-slate-700" : "text-teal-700")}>
                {m.direction === "in" ? "Cliente:" : m.sender === "human" ? "Equipo:" : "Asistente:"}
              </span>
              <span className="text-slate-600">{m.text}</span>
            </p>
          ))}
        </div>
      )}

      <div className="space-y-3 p-4">
        {a.actions.length > 0 && (
          <Alert tone="sky">
            <p className="font-medium">Al aprobar, el sistema hará esto de verdad:</p>
            <ul className="mt-1 list-disc pl-5">
              {a.actions.map((x, i) => <li key={i}>{x.summary}</li>)}
            </ul>
          </Alert>
        )}

        <div>
          <label className="mb-1 flex items-center justify-between text-sm font-medium text-slate-700" htmlFor={`d-${a.id}`}>
            Respuesta que recibirá el cliente
            {changed && <Badge tone="sky">Editada</Badge>}
          </label>
          <textarea
            id={`d-${a.id}`}
            value={text}
            onChange={(e) => setEdit(e.target.value)}
            rows={Math.min(8, Math.max(3, text.split("\n").length + 1))}
            maxLength={3800}
            disabled={!allowed || Boolean(blocked)}
            className="w-full resize-y rounded-xl bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 ring-1 ring-slate-200 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600 disabled:opacity-60"
          />
        </div>

        {blocked && <Alert tone="amber">{blocked} Descarta este borrador o responde desde la bandeja.</Alert>}
        {error && (
          <Alert>
            <p className="font-medium">{error.message}</p>
            {error.details && <ul className="mt-1 list-disc pl-5">{error.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
            {error.details && <p className="mt-1">Corrige el texto o descarta el borrador y atiende desde la bandeja.</p>}
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => run("approve")} loading={busy === "approve"} disabled={!allowed || Boolean(blocked) || !text.trim()}>
            {changed ? "Enviar versión editada" : "Aprobar y enviar"}
          </Button>
          <Button variant="danger" onClick={() => run("discard")} loading={busy === "discard"} disabled={!allowed}>Descartar</Button>
          {!allowed && <span className="text-sm text-slate-500">Tu rol es de solo lectura.</span>}
        </div>
      </div>
    </article>
  );
}
