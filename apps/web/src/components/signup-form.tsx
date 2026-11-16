"use client";

import { useState, type FormEvent } from "react";
import { api } from "@/lib/client";
import { Alert, Button } from "./ui";

const TIMEZONES = [
  { id: "America/Merida", label: "Mérida / Cancún (Península)" },
  { id: "America/Mexico_City", label: "Ciudad de México" },
  { id: "America/Monterrey", label: "Monterrey" },
  { id: "America/Tijuana", label: "Tijuana" },
  { id: "America/Hermosillo", label: "Hermosillo" },
];

export function SignupForm() {
  const [form, setForm] = useState({ businessName: "", ownerName: "", email: "", password: "", timezone: "America/Merida" });
  const [error, setError] = useState<{ text: string; details?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((p) => ({ ...p, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await api<{ ok: true }>("/api/signup", { method: "POST", body: { ...form, vertical: "dental" } });
    if (res.ok) {
      window.location.href = "/facturacion?nuevo=1";
      return;
    }
    setError({ text: res.message, details: res.details });
    setBusy(false);
  }

  const field =
    "mt-1 w-full rounded-lg border-0 bg-white px-3 py-2.5 text-slate-900 shadow-sm ring-1 ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600";

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      {error && (
        <Alert>
          <p>{error.text}</p>
          {error.details && <ul className="mt-1 list-disc pl-5">{error.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
        </Alert>
      )}
      <label className="block text-sm font-medium text-slate-700">Nombre de tu clínica
        <input required className={field} value={form.businessName} onChange={set("businessName")} placeholder="Clínica Dental Sonrisa" />
      </label>
      <label className="block text-sm font-medium text-slate-700">Zona horaria
        <select className={field} value={form.timezone} onChange={set("timezone")}>
          {TIMEZONES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </label>
      <label className="block text-sm font-medium text-slate-700">Tu nombre
        <input required className={field} value={form.ownerName} onChange={set("ownerName")} autoComplete="name" />
      </label>
      <label className="block text-sm font-medium text-slate-700">Correo
        <input required type="email" className={field} value={form.email} onChange={set("email")} autoComplete="username" placeholder="tu@negocio.com" />
      </label>
      <label className="block text-sm font-medium text-slate-700">Contraseña <span className="font-normal text-slate-500">(mínimo 10 caracteres)</span>
        <input required type="password" className={field} value={form.password} onChange={set("password")} autoComplete="new-password" />
      </label>
      <Button type="submit" loading={busy} className="w-full py-2.5">Crear mi cuenta</Button>
      <p className="text-center text-xs text-slate-500">Revisamos cada cuenta nueva antes de activar el asistente; normalmente el mismo día hábil.</p>
    </form>
  );
}
