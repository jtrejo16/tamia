"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, type ReactNode } from "react";
import { api, useLiveUpdates, usePolling } from "@/lib/client";
import { PanelProvider, type PanelInfo } from "./panel-context";
import { Badge, cx } from "./ui";

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

const ICONS = {
  inbox: "M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.7-.8L3 21l1.9-5.2A8.4 8.4 0 1 1 21 11.5Z",
  check: "M9 12l2 2 4-4M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
  calendar: "M8 2v4M16 2v4M3 9h18M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
  flask: "M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9V3",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  out: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z",
  users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  cog: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
};

interface NavItem {
  href: string;
  label: string;
  icon: string;
  badge: "attention" | "approvals" | null;
  /** Solo se muestra a los negocios que tienen este modulo. Sin valor: es del nucleo y siempre esta. */
  module?: string;
}

const ITEMS: NavItem[] = [
  { href: "/bandeja", label: "Bandeja", icon: ICONS.inbox, badge: "attention" },
  { href: "/aprobaciones", label: "Aprobaciones", icon: ICONS.check, badge: "approvals" },
  { href: "/citas", label: "Citas", icon: ICONS.calendar, badge: null, module: "citas" },
  { href: "/clientes", label: "Clientes", icon: ICONS.users, badge: null },
  { href: "/llamadas", label: "Llamadas", icon: ICONS.phone, badge: null },
  { href: "/estadisticas", label: "Estadísticas", icon: ICONS.chart, badge: null },
  { href: "/probador", label: "Probador", icon: ICONS.flask, badge: null },
  { href: "/configuracion", label: "Ajustes", icon: ICONS.cog, badge: null },
];

/** Pantallas que aporta cada modulo (el de restaurante agregara Pedidos, Menu y Reservaciones). Van despues de «Aprobaciones». */
const MODULE_NAV: Record<string, NavItem[]> = {};

/** Menu del panel de un negocio: el nucleo, mas las pantallas de sus modulos. Con "citas" queda igual que siempre. */
export function navFor(modules: readonly string[]): NavItem[] {
  const base = ITEMS.filter((i) => !i.module || modules.includes(i.module));
  const extra = modules.flatMap((m) => MODULE_NAV[m] ?? []);
  const at = base.findIndex((i) => i.href === "/aprobaciones") + 1;
  return [...base.slice(0, at), ...extra, ...base.slice(at)];
}

const ACCESS_TEXT: Record<string, string> = {
  tenant_pending: "Tu cuenta está en revisión; en cuanto la aprobemos empezará a responder. Mientras, puedes configurar tu negocio.",
  tenant_inactive: "Tu negocio está pausado. Contacta a soporte.",
  no_subscription: "No hay una suscripción registrada.",
  trial_ended: "Terminó tu prueba gratis.",
  payment_overdue: "No se pudo cobrar tu suscripción.",
  canceled: "La suscripción está cancelada.",
};

/** Aviso discreto cuando quedan pocos dias de prueba. */
function TrialNote({ iso, owner }: { iso: string; owner: boolean }) {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days > 5 || days < 0) return null;
  return (
    <div className="border-b border-sky-200 bg-sky-50 px-4 py-1.5 text-sm text-sky-900">
      Tu prueba gratis termina {days <= 0 ? "hoy" : `en ${days} día${days === 1 ? "" : "s"}`}.{" "}
      {owner && <Link href="/facturacion" className="font-semibold underline">Elegir plan</Link>}
    </div>
  );
}

export function PanelShell({ info, children }: { info: PanelInfo; children: ReactNode }) {
  const pathname = usePathname();
  const nav = useMemo(() => navFor(info.modules), [info.modules]);
  useLiveUpdates();
  const { data: counts } = usePolling<{ ok: true; attention: number; approvals: number; worker: boolean; access?: { allowed: boolean; reason: string; trialEndsAt: string | null } }>("/api/summary", 6000);
  // La del servidor al cargar la pagina; la del resumen la mantiene al dia sin recargar (por ejemplo, al pagar).
  const access = counts?.access ?? info.access;
  const sendingDown = counts !== null && counts.worker === false;

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  const badge = (key: "attention" | "approvals" | null) => {
    const n = key && counts ? counts[key] : 0;
    return n > 0 ? (
      <span className="ml-auto rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-white" aria-label={`${n} pendientes`}>
        {n > 99 ? "99+" : n}
      </span>
    ) : null;
  };

  return (
    <PanelProvider value={info}>
      <div className="flex h-dvh flex-col lg:flex-row">
        {/* Barra lateral (escritorio) */}
        <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
          <div className="p-5">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-700 font-bold text-white">J</div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">{info.tenantName}</p>
                <p className="text-xs text-slate-500">Jovia</p>
              </div>
            </div>
          </div>
          <nav className="flex-1 space-y-1 px-3">
            {nav.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cx(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    active ? "bg-teal-50 text-teal-800" : "text-slate-600 hover:bg-slate-100",
                  )}
                >
                  <Icon d={item.icon} />
                  {item.label}
                  {badge(item.badge)}
                </Link>
              );
            })}
          </nav>
          <div className="space-y-3 border-t border-slate-200 p-4">
            {info.llmMode === "free" && (
              <Badge tone="amber" className="w-full justify-center py-1">
                IA gratuita · solo pruebas
              </Badge>
            )}
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800">{info.userName}</p>
                <p className="text-xs text-slate-500">{{ owner: "Dueño", agent: "Recepción", viewer: "Solo lectura" }[info.role]}</p>
              </div>
              <button onClick={logout} title="Cerrar sesión" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800">
                <Icon d={ICONS.out} />
              </button>
            </div>
            <Link href="/cuenta" className="block text-center text-xs font-medium text-teal-700 hover:underline">Mi cuenta y contraseña</Link>
            {info.role === "owner" && <Link href="/facturacion" className="block text-center text-xs font-medium text-teal-700 hover:underline">Facturación</Link>}
            {info.isOperator && <Link href="/operador" className="block text-center text-xs font-medium text-teal-700 hover:underline">Operador de la plataforma</Link>}
          </div>
        </aside>

        {/* Barra superior (celular) */}
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5 lg:hidden">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">{info.tenantName}</p>
            {info.llmMode === "free" && <p className="text-xs text-amber-700">IA gratuita · solo pruebas</p>}
          </div>
          <div className="flex items-center gap-1">
            {info.role === "owner" && <Link href="/facturacion" className="rounded-lg px-2 py-1 text-xs font-medium text-teal-700 hover:bg-slate-100">Plan</Link>}
            {info.isOperator && <Link href="/operador" className="rounded-lg px-2 py-1 text-xs font-medium text-teal-700 hover:bg-slate-100">Operador</Link>}
            <Link href="/cuenta" className="rounded-lg px-2 py-1 text-xs font-medium text-teal-700 hover:bg-slate-100">Mi cuenta</Link>
            <button onClick={logout} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" title="Cerrar sesión">
              <Icon d={ICONS.out} />
            </button>
          </div>
        </header>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!access.allowed && (
            <div role="alert" className="border-b border-amber-300 bg-amber-100 px-4 py-2 text-sm text-amber-900">
              <strong>El asistente está detenido.</strong>{" "}
              {ACCESS_TEXT[access.reason] ?? "Revisa tu suscripción."}{" "}
              {info.role === "owner" && access.reason !== "tenant_pending" && access.reason !== "tenant_inactive" && (
                <Link href="/facturacion" className="font-semibold underline">Ver planes</Link>
              )}
            </div>
          )}
          {access.allowed && access.trialEndsAt && <TrialNote iso={access.trialEndsAt} owner={info.role === "owner"} />}
          {sendingDown && (
            <div role="alert" className="border-b border-amber-300 bg-amber-100 px-4 py-2 text-sm text-amber-900">
              <strong>El servicio de envío de WhatsApp está detenido.</strong> Lo que escribas o apruebes queda en cola y llegará al cliente cuando se reanude.
            </div>
          )}
          <main className="min-h-0 min-w-0 flex-1">{children}</main>
        </div>

        {/* Barra inferior (celular) */}
        <nav className="flex overflow-x-auto border-t border-slate-200 bg-white lg:hidden">
          {nav.map((item) => {
            const active = pathname.startsWith(item.href);
            const n = item.badge && counts ? counts[item.badge] : 0;
            return (
              <Link key={item.href} href={item.href} className={cx("relative flex min-w-[76px] flex-1 flex-col items-center gap-0.5 py-2 text-xs font-medium", active ? "text-teal-800" : "text-slate-500")}>
                <Icon d={item.icon} />
                {item.label}
                {n > 0 && <span className="absolute right-[22%] top-1 rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-white">{n}</span>}
              </Link>
            );
          })}
        </nav>
      </div>
    </PanelProvider>
  );
}
