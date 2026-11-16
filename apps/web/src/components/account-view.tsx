"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/lib/client";
import { Alert, Badge, Button } from "./ui";

const field =
  "mt-1 w-full rounded-lg bg-white px-3 py-2.5 text-slate-900 shadow-sm ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-teal-600";

interface Tenant {
  tenantId: string;
  name: string;
  role: "owner" | "agent" | "viewer";
}

const ROLE = { owner: "Dueño", agent: "Recepción", viewer: "Solo lectura" };

export function AccountView({ name, email, tenantName, mustChange }: { name: string; email: string; tenantName: string; mustChange: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "green" | "rose"; text: string; details?: string[] } | null>(null);
  const [tenants, setTenants] = useState<{ items: Tenant[]; current: string } | null>(null);

  useEffect(() => {
    if (mustChange) return;
    void api<{ ok: true; items: Tenant[]; current: string }>("/api/account/tenants").then((r) => r.ok && setTenants({ items: r.items, current: r.current }));
  }, [mustChange]);

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    if (next !== again) return setNotice({ tone: "rose", text: "Las contraseñas nuevas no coinciden." });
    setBusy("password");
    const res = await api<{ ok: true }>("/api/account/password", { method: "POST", body: { current, next } });
    setBusy(null);
    if (res.ok) {
      setCurrent("");
      setNext("");
      setAgain("");
      if (mustChange) {
        window.location.href = "/bandeja";
        return;
      }
      setNotice({ tone: "green", text: "Contraseña actualizada. Se cerró tu sesión en los demás dispositivos." });
    } else {
      setNotice({ tone: "rose", text: res.message, details: res.details });
    }
  }

  async function signOutAll() {
    if (!window.confirm("Se cerrará tu sesión en todos tus dispositivos, incluido este. ¿Continuar?")) return;
    setBusy("all");
    await api("/api/account/signout-all", { method: "POST" });
    window.location.href = "/login";
  }

  async function switchTo(tenantId: string) {
    setBusy(tenantId);
    const res = await api<{ ok: true }>("/api/account/switch", { method: "POST", body: { tenantId } });
    if (res.ok) window.location.href = "/bandeja";
    else {
      setBusy(null);
      setNotice({ tone: "rose", text: res.message });
    }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <main className="mx-auto max-w-xl space-y-4 p-4 sm:p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Mi cuenta</h1>
        {!mustChange && <Link href="/bandeja" className="text-sm font-medium text-teal-700 hover:underline">← Volver al panel</Link>}
      </div>

      <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <p className="font-medium text-slate-900">{name}</p>
        <p className="text-sm text-slate-500">{email} · {tenantName}</p>
      </section>

      {mustChange && (
        <Alert tone="amber">
          <p className="font-medium">Tu contraseña es temporal.</p>
          <p>Elige una nueva para continuar. Usa al menos 10 caracteres.</p>
        </Alert>
      )}

      <form onSubmit={changePassword} className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 className="font-semibold text-slate-900">Cambiar mi contraseña</h2>
        {notice && (
          <Alert tone={notice.tone}>
            <p className="font-medium">{notice.text}</p>
            {notice.details && <ul className="mt-1 list-disc pl-5">{notice.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
          </Alert>
        )}
        <label className="block text-sm font-medium text-slate-700">
          {mustChange ? "Contraseña temporal" : "Contraseña actual"}
          <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} className={field} />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Contraseña nueva
          <input type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} className={field} />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Repite la contraseña nueva
          <input type="password" autoComplete="new-password" required minLength={10} value={again} onChange={(e) => setAgain(e.target.value)} className={field} />
        </label>
        <Button type="submit" loading={busy === "password"}>Guardar contraseña</Button>
      </form>

      {!mustChange && tenants && tenants.items.length > 1 && (
        <section className="space-y-3 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="font-semibold text-slate-900">Mis negocios</h2>
          <ul className="divide-y divide-slate-100">
            {tenants.items.map((t) => (
              <li key={t.tenantId} className="flex items-center justify-between gap-3 py-2.5">
                <span>
                  <span className="font-medium text-slate-900">{t.name}</span>{" "}
                  <Badge tone="slate">{ROLE[t.role]}</Badge>
                </span>
                {t.tenantId === tenants.current ? (
                  <Badge tone="green">Actual</Badge>
                ) : (
                  <Button variant="secondary" className="px-3 py-1.5" loading={busy === t.tenantId} onClick={() => switchTo(t.tenantId)}>Cambiar a este</Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 className="font-semibold text-slate-900">Sesiones</h2>
        <p className="text-sm text-slate-500">Si perdiste un dispositivo o sospechas que alguien más tiene acceso, cierra todas tus sesiones.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={logout}>Cerrar sesión</Button>
          <Button variant="danger" loading={busy === "all"} onClick={signOutAll}>Cerrar sesión en todos los dispositivos</Button>
        </div>
      </section>
    </main>
  );
}
