import type { ReactNode } from "react";

/** Piezas visuales compartidas por las portadas publicas (inicio y «Para restaurantes»). */

/* ------------------------------------------------------------------ piezas */

export function SectionTitle({ kicker, title, align = "center" }: { kicker: string; title: string; align?: "center" | "left" }) {
  return (
    <div className={align === "center" ? "mx-auto max-w-2xl text-center" : ""}>
      <p className="text-sm font-semibold uppercase tracking-wider text-teal-700">{kicker}</p>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">{title}</h2>
    </div>
  );
}

export function Pain({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-2xl bg-white p-6 ring-1 ring-slate-200">
      <h3 className="font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 text-[15px] leading-relaxed text-slate-600">{text}</p>
    </div>
  );
}

export function Feature({ icon, title, text, tag }: { icon: ReactNode; title: string; text: string; tag?: string }) {
  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <div className="flex items-center justify-between">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-teal-50 text-teal-700">{icon}</span>
        {tag && <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-900">{tag}</span>}
      </div>
      <h3 className="mt-4 font-semibold text-slate-900">{title}</h3>
      <p className="mt-1.5 text-[15px] leading-relaxed text-slate-600">{text}</p>
    </div>
  );
}

export function Bubble({ who, children }: { who: "in" | "out"; children: ReactNode }) {
  return (
    <div className={`flex ${who === "out" ? "justify-end" : "justify-start"}`}>
      <p className={`max-w-[85%] rounded-2xl px-3 py-2 shadow-sm ${who === "out" ? "rounded-tr-sm bg-[#d9fdd3]" : "rounded-tl-sm bg-white"}`}>{children}</p>
    </div>
  );
}

const icon = "h-5 w-5";
const svg = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", viewBox: "0 0 24 24", "aria-hidden": true } as const;

export function Check() {
  return (
    <svg className="h-4 w-4 text-teal-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z" clipRule="evenodd" />
    </svg>
  );
}
export const IconChat = () => <svg className={icon} {...svg}><path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.6A8 8 0 1 1 21 12Z" /></svg>;
export const IconCalendar = () => <svg className={icon} {...svg}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18M9 15l2 2 4-4" /></svg>;
export const IconBell = () => <svg className={icon} {...svg}><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8ZM10.3 20a2 2 0 0 0 3.4 0" /></svg>;
export const IconUser = () => <svg className={icon} {...svg}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
export const IconShield = () => <svg className={icon} {...svg}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></svg>;
export const IconChart = () => <svg className={icon} {...svg}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>;
export const IconPhone = () => <svg className={icon} {...svg}><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z" /></svg>;
export const IconFacebook = () => <svg className={icon} {...svg}><circle cx="12" cy="12" r="9" /><path d="M13.5 8H15V5.5h-1.5A3 3 0 0 0 10.5 8.5V10H9v2.5h1.5V19h2.5v-6.5H15L15.5 10h-2.5V8.7c0-.4.2-.7.5-.7Z" /></svg>;
export const IconSync = () => <svg className={icon} {...svg}><path d="M21 12a9 9 0 0 1-15.4 6.4L3 16M3 12a9 9 0 0 1 15.4-6.4L21 8M3 21v-5h5M21 3v5h-5" /></svg>;
