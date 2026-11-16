"use client";

import type { BillingView as Billing } from "@empleado/inbox";
import { PLANS, PLAN_IDS, TRIAL_DAYS, type PlanId } from "@empleado/shared/plans";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { usePanel } from "./panel-context";
import { Alert, Badge, Button, Spinner, cx } from "./ui";

type Data = Serialized<Billing> & { ok: true };

const REASONS: Record<string, string> = {
  tenant_pending: "Tu cuenta está en revisión. Te activamos el asistente en cuanto la aprobemos; mientras, puedes configurar tu negocio.",
  tenant_inactive: "Tu negocio está pausado. Contacta a soporte.",
  no_subscription: "Tu negocio no tiene una suscripción registrada.",
  trial_ended: "Terminó tu prueba gratis. Elige un plan para que el asistente vuelva a responder.",
  payment_overdue: "No se pudo cobrar tu suscripción. Revisa tu pago en Mercado Pago o elige un plan de nuevo.",
  canceled: "Cancelaste tu suscripción. Elige un plan para reactivar el asistente.",
};

const STATUS_LABEL: Record<string, string> = {
  trialing: "En prueba gratis",
  active: "Activa",
  past_due: "Pago pendiente",
  canceled: "Cancelada",
  comped: "Cortesía",
};

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" }) : null;

export function BillingView() {
  const { role } = usePanel();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<Data>("/api/billing");
    if (res.ok) setData(res);
    else setError(res.message);
  }, []);

  useEffect(() => {
    // Al volver de Mercado Pago se consulta el estado real antes de mostrar.
    const back = new URLSearchParams(window.location.search).get("volvio") === "1";
    void (async () => {
      if (back && role === "owner") await api("/api/billing/refresh", { method: "POST" });
      await load();
    })();
  }, [load, role]);

  async function choose(plan: PlanId) {
    setBusy(plan);
    setError(null);
    const res = await api<{ ok: true; url: string }>("/api/billing/checkout", { method: "POST", body: { plan } });
    if (res.ok) {
      window.location.href = res.url;
      return;
    }
    setError(res.message);
    setBusy(null);
  }

  async function act(kind: "cancel" | "refresh") {
    if (kind === "cancel" && !window.confirm("¿Cancelar tu suscripción?\n\nEl asistente dejará de responder cuando termine el periodo ya cubierto.")) return;
    setBusy(kind);
    setError(null);
    const res = await api(`/api/billing/${kind}`, { method: "POST" });
    if (!res.ok) setError(res.message);
    else setNotice(kind === "cancel" ? "Suscripción cancelada." : "Estado actualizado ✓");
    await load();
    setBusy(null);
  }

  if (!data) return <div className="flex justify-center p-10 text-slate-400">{error ? <Alert>{error}</Alert> : <Spinner />}</div>;

  const sub = data.subscription;
  const isOwner = role === "owner";
  const comped = sub?.status === "comped";

  return (
    <div className="mx-auto h-full max-w-4xl space-y-5 overflow-y-auto p-4 sm:p-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Facturación</h1>
        <p className="text-sm text-slate-500">Tu plan y el cobro de tu suscripción.</p>
      </div>

      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone="green">{notice}</Alert>}
      {!data.access.allowed && <Alert tone="amber">{REASONS[data.access.reason] ?? "El asistente está detenido."}</Alert>}

      <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-semibold text-slate-900">Plan {PLANS[data.plan].name}</h2>
          {sub && (
            <Badge tone={sub.status === "active" || sub.status === "comped" ? "green" : sub.status === "trialing" ? "teal" : "amber"}>
              {STATUS_LABEL[sub.status]}
            </Badge>
          )}
        </div>
        {sub?.status === "trialing" && sub.trialEndsAt && (
          <p className="mt-2 text-sm text-slate-600">
            Tu prueba gratis termina el <strong>{fmtDate(sub.trialEndsAt)}</strong>.
            {sub.cardAuthorized ? " Tu tarjeta ya está autorizada: el primer cobro será ese día." : " Elige un plan antes para no interrumpir el servicio."}
          </p>
        )}
        {sub?.status === "active" && sub.currentPeriodEnd && (
          <p className="mt-2 text-sm text-slate-600">Próximo cobro: <strong>{fmtDate(sub.currentPeriodEnd)}</strong>.</p>
        )}
        {sub?.status === "canceled" && data.access.allowed && (
          <p className="mt-2 text-sm text-slate-600">
            Cancelaste tu suscripción: <strong>no se te volverá a cobrar</strong>. Tu asistente sigue funcionando hasta el <strong>{fmtDate(sub.accessEndsAt)}</strong>. Si cambias de opinión, elige un plan abajo: el primer cobro será ese día.
          </p>
        )}
        {comped && <p className="mt-2 text-sm text-slate-600">Tu negocio tiene una cortesía: no requiere pago.</p>}
        {isOwner && sub?.hasCheckout && !comped && sub.status !== "canceled" && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" loading={busy === "refresh"} onClick={() => act("refresh")}>Actualizar estado</Button>
            {sub.cardAuthorized && <Button variant="danger" loading={busy === "cancel"} onClick={() => act("cancel")}>Cancelar suscripción</Button>}
          </div>
        )}
      </section>

      {!comped && (
        <section>
          <h2 className="mb-3 font-semibold text-slate-900">Elige tu plan</h2>
          {!isOwner && <p className="mb-3 text-sm text-slate-500">Solo el dueño del negocio puede cambiar el plan.</p>}
          {isOwner && !data.paymentsEnabled && (
            <Alert tone="amber" className="mb-3">El cobro en línea todavía no está disponible. Contacta a soporte.</Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            {PLAN_IDS.map((id) => {
              const p = PLANS[id];
              const current = data.plan === id && Boolean(sub?.cardAuthorized);
              return (
                <div key={id} className={cx("flex flex-col rounded-2xl bg-white p-5 shadow-sm", id === "profesional" ? "ring-2 ring-teal-600" : "ring-1 ring-slate-200")}>
                  <h3 className="font-semibold text-slate-900">{p.name}</h3>
                  <p className="mt-1 text-2xl font-bold text-slate-900">
                    ${p.priceMxn.toLocaleString("es-MX")}<span className="text-sm font-normal text-slate-500"> MXN/mes</span>
                  </p>
                  <p className="mt-1 text-sm text-slate-500">{p.tagline}</p>
                  <ul className="my-4 flex-1 space-y-1.5 text-sm text-slate-700">
                    {p.features.map((f) => <li key={f}>✓ {f}</li>)}
                  </ul>
                  <Button
                    disabled={!isOwner || !data.paymentsEnabled || current}
                    loading={busy === id}
                    onClick={() => choose(id)}
                    variant={id === "profesional" ? "primary" : "secondary"}
                  >
                    {current ? "Tu plan actual" : sub?.status === "trialing" ? "Elegir este plan" : "Suscribirme"}
                  </Button>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Pagas con tarjeta en Mercado Pago; nosotros nunca vemos los datos de tu tarjeta. Los primeros {TRIAL_DAYS} días son gratis: si eliges plan durante la prueba, el primer cobro es al terminarla. Precios con IVA incluido.
          </p>
        </section>
      )}
    </div>
  );
}
