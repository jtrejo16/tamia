"use client";

import { useState, type FormEvent } from "react";
import { api } from "@/lib/client";
import { Alert, Button } from "./ui";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await api<{ ok: true; mustChangePassword: boolean }>("/api/auth/login", { method: "POST", body: { email, password } });
    if (res.ok) {
      window.location.href = res.mustChangePassword ? "/cuenta?obligatorio=1" : "/bandeja";
      return;
    }
    setError(res.message);
    setPassword("");
    setBusy(false);
  }

  const field =
    "mt-1 w-full rounded-lg border-0 bg-white px-3 py-2.5 text-slate-900 shadow-sm ring-1 ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600";

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      {error && <Alert>{error}</Alert>}
      <label className="block text-sm font-medium text-slate-700">
        Correo
        <input type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className={field} placeholder="tu@negocio.com" />
      </label>
      <label className="block text-sm font-medium text-slate-700">
        Contraseña
        <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
      </label>
      <Button type="submit" loading={busy} className="w-full py-2.5">
        Entrar
      </Button>
    </form>
  );
}
