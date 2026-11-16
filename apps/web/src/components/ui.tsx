"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

export const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-teal-700 text-white hover:bg-teal-800 disabled:bg-teal-700/50",
  secondary: "bg-white text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-50",
  ghost: "text-slate-600 hover:bg-slate-100 disabled:opacity-50",
  danger: "bg-white text-rose-700 ring-1 ring-rose-300 hover:bg-rose-50 disabled:opacity-50",
};

export function Button({
  variant = "primary",
  className,
  loading,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-1 disabled:cursor-not-allowed",
        VARIANTS[variant],
        className,
      )}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("animate-spin", className ?? "h-5 w-5")} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

type Tone = "slate" | "teal" | "amber" | "rose" | "sky" | "green";
const TONES: Record<Tone, string> = {
  slate: "bg-slate-100 text-slate-700",
  teal: "bg-teal-50 text-teal-800",
  amber: "bg-amber-100 text-amber-800",
  rose: "bg-rose-100 text-rose-800",
  sky: "bg-sky-100 text-sky-800",
  green: "bg-green-100 text-green-800",
};

export function Badge({ tone = "slate", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONES[tone], className)}>
      {children}
    </span>
  );
}

export function Alert({ tone = "rose", children, className }: { tone?: "rose" | "amber" | "sky" | "green"; children: ReactNode; className?: string }) {
  const tones = {
    rose: "bg-rose-50 text-rose-900 ring-rose-200",
    amber: "bg-amber-50 text-amber-900 ring-amber-200",
    sky: "bg-sky-50 text-sky-900 ring-sky-200",
    green: "bg-green-50 text-green-900 ring-green-200",
  };
  return <div role={tone === "rose" ? "alert" : "status"} className={cx("rounded-lg px-3 py-2 text-sm ring-1", tones[tone], className)}>{children}</div>;
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      {icon && <div className="text-slate-300">{icon}</div>}
      <p className="font-medium text-slate-700">{title}</p>
      {hint && <p className="max-w-xs text-sm text-slate-500">{hint}</p>}
    </div>
  );
}

/** Muestra *negrita* como la ve el cliente en WhatsApp (el resto, texto plano: sin HTML inyectado). */
export function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*[^*\n]+\*)/g).map((part, i) =>
        /^\*[^*\n]+\*$/.test(part) ? <strong key={i}>{part.slice(1, -1)}</strong> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const initial = (name.replace(/[^\p{L}\p{N}]/gu, "")[0] ?? "?").toUpperCase();
  return (
    <div className={cx("flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-teal-100 font-semibold text-teal-800", className)} aria-hidden>
      {initial}
    </div>
  );
}
