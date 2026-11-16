"use client";

import type { MemberView } from "@empleado/inbox";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { Serialized } from "@/lib/types";
import { Alert, Badge, Button, Spinner, cx } from "./ui";

type Member = Serialized<MemberView>;

const field =
  "w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-900 ring-1 ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600";

const ROLES = [
  { id: "owner", label: "Dueño", hint: "Todo, incluida la configuración y los usuarios" },
  { id: "agent", label: "Recepción", hint: "Atiende conversaciones, aprueba y maneja citas" },
  { id: "viewer", label: "Solo lectura", hint: "Puede ver, no puede cambiar nada" },
] as const;

export function UsersTab() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "green" | "rose"; text: string; details?: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ who: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", role: "agent" });

  const load = useCallback(async () => {
    const res = await api<{ ok: true; items: Member[] }>("/api/users");
    if (res.ok) {
      setMembers(res.items);
      setError(null);
    } else setError(res.message);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function post<T extends { ok: true }>(key: string, action: string, body: unknown): Promise<T | null> {
    setBusy(key);
    setNotice(null);
    const res = await api<T>(`/api/users/${action}`, { method: "POST", body });
    setBusy(null);
    if (!res.ok) {
      setNotice({ tone: "rose", text: res.message, details: res.details });
      return null;
    }
    await load();
    return res;
  }

  async function add() {
    const res = await post<{ ok: true; created: boolean; temporaryPassword?: string }>("add", "add", form);
    if (!res) return;
    setForm({ email: "", name: "", role: "agent" });
    if (res.temporaryPassword) {
      setSecret({ who: form.email, password: res.temporaryPassword });
      setCopied(false);
    } else {
      setNotice({ tone: "green", text: "Esa persona ya tenía cuenta: se le dio acceso a este negocio con su contraseña de siempre." });
    }
  }

  async function reset(m: Member) {
    if (!window.confirm(`¿Restablecer la contraseña de ${m.email}?\n\nSe cerrarán sus sesiones y recibirá una contraseña temporal.`)) return;
    const res = await post<{ ok: true; temporaryPassword: string }>(`reset-${m.userId}`, "reset", { userId: m.userId });
    if (res) {
      setSecret({ who: m.email, password: res.temporaryPassword });
      setCopied(false);
    }
  }

  async function remove(m: Member) {
    if (!window.confirm(`¿Dar de baja a ${m.email}?\n\nPerderá el acceso a este negocio de inmediato.`)) return;
    const res = await post(`remove-${m.userId}`, "remove", { userId: m.userId });
    if (res) setNotice({ tone: "green", text: "Persona dada de baja ✓" });
  }

  async function changeRole(m: Member, role: string) {
    const res = await post(`role-${m.userId}`, "role", { userId: m.userId, role });
    if (res) setNotice({ tone: "green", text: "Rol actualizado ✓" });
  }

  if (error && !members) return <Alert>{error}</Alert>;
  if (!members) return <div className="flex justify-center p-10 text-slate-400"><Spinner /></div>;

  return (
    <div className="space-y-4">
      {secret && (
        <Alert tone="amber">
          <p className="font-semibold">Contraseña temporal para {secret.who}</p>
          <p className="my-2 flex flex-wrap items-center gap-2">
            <code className="rounded bg-white px-3 py-1.5 font-mono text-base tracking-wide text-slate-900 ring-1 ring-amber-300">{secret.password}</code>
            <Button
              variant="secondary"
              className="px-3 py-1.5"
              onClick={async () => {
                await navigator.clipboard?.writeText(secret.password).catch(() => {});
                setCopied(true);
              }}
            >
              {copied ? "Copiada ✓" : "Copiar"}
            </Button>
          </p>
          <p>Entrégala por un medio seguro (no por un chat grupal). <strong>Solo se muestra ahora</strong>: no queda guardada en ningún lado. La persona deberá cambiarla al entrar.</p>
          <Button variant="ghost" className="mt-2 px-2 py-1" onClick={() => setSecret(null)}>Ya la entregué, ocultar</Button>
        </Alert>
      )}
      {notice && (
        <Alert tone={notice.tone}>
          <p className="font-medium">{notice.text}</p>
          {notice.details && <ul className="mt-1 list-disc pl-5">{notice.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
        </Alert>
      )}

      <section className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
        <ul className="divide-y divide-slate-100">
          {members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-slate-900">
                  {m.name ?? m.email} {m.isYou && <Badge tone="teal">Tú</Badge>} {m.mustChangePassword && <Badge tone="amber">Contraseña temporal</Badge>}
                </p>
                {m.name && <p className="truncate text-sm text-slate-500">{m.email}</p>}
              </div>
              <select
                className={cx(field, "w-auto")}
                value={m.role}
                disabled={busy === `role-${m.userId}`}
                onChange={(e) => changeRole(m, e.target.value)}
                aria-label={`Rol de ${m.email}`}
              >
                {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
              {!m.isYou && (
                <div className="flex gap-1.5">
                  <Button variant="secondary" className="px-2.5 py-1 text-xs" loading={busy === `reset-${m.userId}`} onClick={() => reset(m)}>Restablecer contraseña</Button>
                  <Button variant="danger" className="px-2.5 py-1 text-xs" loading={busy === `remove-${m.userId}`} onClick={() => remove(m)}>Dar de baja</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <div>
          <h2 className="font-semibold text-slate-900">Agregar a alguien</h2>
          <p className="text-sm text-slate-500">Se le crea una cuenta con una contraseña temporal. Si ya tiene cuenta en otro negocio, solo se le da acceso a este.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-700">Correo
            <input className={cx(field, "mt-1")} type="email" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} placeholder="persona@negocio.com" />
          </label>
          <label className="block text-sm font-medium text-slate-700">Nombre (opcional)
            <input className={cx(field, "mt-1")} value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} />
          </label>
          <label className="block text-sm font-medium text-slate-700 sm:col-span-2">Rol
            <select className={cx(field, "mt-1")} value={form.role} onChange={(e) => setForm((p) => ({ ...p, role: e.target.value }))}>
              {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label} — {r.hint}</option>)}
            </select>
          </label>
        </div>
        <Button onClick={add} loading={busy === "add"} disabled={!form.email.trim()}>Agregar</Button>
      </section>
    </div>
  );
}
