"use client";

import type { OperatorTenantRow } from "@empleado/db";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { Alert, Badge, Button, Spinner } from "./ui";

type Row = Serialized<OperatorTenantRow>;

const STATUS: Record<string, { label: string; tone: "amber" | "green" | "slate" | "rose" }> = {
  pending: { label: "Pendiente de aprobar", tone: "amber" },
  active: { label: "Activo", tone: "green" },
  paused: { label: "Pausado", tone: "slate" },
  cancelled: { label: "Cancelado", tone: "rose" },
};

const SUB: Record<string, string> = {
  trialing: "Prueba",
  active: "Pagando",
  past_due: "Pago pendiente",
  canceled: "Cancelada",
  comped: "Cortesía",
};

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" }) : "—");

export function OperatorView() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ ok: true; items: Row[] }>("/api/operator");
    if (res.ok) setRows(res.items);
    else setError(res.message);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, action: "status" | "comped", body: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(key);
    setError(null);
    const res = await api(`/api/operator/${action}`, { method: "POST", body });
    if (!res.ok) setError(res.message);
    await load();
    setBusy(null);
  }

  if (!rows) return <div className="flex justify-center p-10 text-slate-400">{error ? <Alert>{error}</Alert> : <Spinner />}</div>;

  const pending = rows.filter((r) => r.status === "pending").length;

  return (
    <div className="mx-auto h-full max-w-5xl space-y-4 overflow-y-auto p-4 sm:p-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Operador</h1>
        <p className="text-sm text-slate-500">
          {rows.length} negocio(s){pending > 0 && <> · <strong className="text-amber-700">{pending} por aprobar</strong></>}. Aprobar activa al asistente (si su suscripción está vigente).
        </p>
      </div>
      {error && <Alert>{error}</Alert>}

      <ul className="space-y-3">
        {rows.map((r) => {
          const st = STATUS[r.status] ?? { label: r.status, tone: "slate" as const };
          return (
            <li key={r.id} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-slate-900">{r.name}</p>
                <Badge tone={st.tone}>{st.label}</Badge>
                {r.subStatus && <Badge tone={r.subStatus === "past_due" || r.subStatus === "canceled" ? "amber" : "slate"}>{SUB[r.subStatus] ?? r.subStatus}</Badge>}
                {r.cardAuthorized && <Badge tone="teal">Tarjeta autorizada</Badge>}
                <Badge tone={r.channelConnected ? "green" : "slate"}>{r.channelConnected ? "WhatsApp conectado" : "Sin WhatsApp"}</Badge>
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {r.ownerEmail ?? "sin dueño"} · plan {r.plan} · {r.vertical} · alta {day(r.createdAt)}
                {r.subStatus === "trialing" && <> · prueba hasta {day(r.trialEndsAt)}</>}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {r.status !== "active" && (
                  <Button className="px-3 py-1.5" loading={busy === `a-${r.id}`} onClick={() => act(`a-${r.id}`, "status", { tenantId: r.id, status: "active" })}>
                    {r.status === "pending" ? "Aprobar" : "Reactivar"}
                  </Button>
                )}
                {r.status === "active" && (
                  <Button variant="secondary" className="px-3 py-1.5" loading={busy === `p-${r.id}`} onClick={() => act(`p-${r.id}`, "status", { tenantId: r.id, status: "paused" }, `¿Pausar a ${r.name}? Sus usuarios no podrán entrar y el asistente dejará de responder.`)}>
                    Pausar
                  </Button>
                )}
                {r.status === "pending" && (
                  <Button variant="danger" className="px-3 py-1.5" loading={busy === `c-${r.id}`} onClick={() => act(`c-${r.id}`, "status", { tenantId: r.id, status: "cancelled" }, `¿Rechazar y cancelar a ${r.name}?`)}>
                    Rechazar
                  </Button>
                )}
                <Button variant="ghost" className="px-3 py-1.5" loading={busy === `k-${r.id}`} onClick={() => act(`k-${r.id}`, "comped", { tenantId: r.id, on: r.subStatus !== "comped" })}>
                  {r.subStatus === "comped" ? "Quitar cortesía" : "Dar cortesía"}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
