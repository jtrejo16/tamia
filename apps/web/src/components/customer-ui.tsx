"use client";

import type { CustomerSegment } from "@empleado/inbox";
import { Badge } from "./ui";

type Tone = "slate" | "teal" | "amber" | "rose" | "sky" | "green";

export const SEGMENTS: Record<CustomerSegment, { text: string; tone: Tone; hint: string }> = {
  prospecto: { text: "Prospecto", tone: "slate", hint: "Escribió o llamó, pero nunca ha agendado." },
  nuevo: { text: "Nuevo", tone: "sky", hint: "Tiene una cita (próxima o por cerrar) o una sola visita." },
  recurrente: { text: "Recurrente", tone: "green", hint: "Ya vino 2 o más veces." },
  en_riesgo: { text: "En riesgo", tone: "amber", hint: "Más de 60 días sin venir y sin cita próxima." },
  perdido: { text: "Perdido", tone: "rose", hint: "Más de 120 días sin venir y sin cita próxima." },
};

export function SegmentBadge({ segment }: { segment: CustomerSegment }) {
  const s = SEGMENTS[segment];
  return (
    <span title={s.hint}>
      <Badge tone={s.tone}>{s.text}</Badge>
    </span>
  );
}

const CHANNELS: Record<string, { label: string; tone: Tone }> = {
  whatsapp: { label: "WhatsApp", tone: "green" },
  messenger: { label: "Messenger", tone: "sky" },
  instagram: { label: "Instagram", tone: "rose" },
  voice: { label: "Llamada", tone: "amber" },
};

export function ChannelBadges({ channels }: { channels: string[] }) {
  return (
    <>
      {channels.map((c) => (
        <Badge key={c} tone={CHANNELS[c]?.tone ?? "slate"}>{CHANNELS[c]?.label ?? c}</Badge>
      ))}
    </>
  );
}

/** "+529991234567" → "+52 999 123 4567". Otros formatos se muestran como estan. */
export function prettyPhone(phone: string | null): string {
  if (!phone) return "Sin teléfono";
  const m = /^\+52(1?)(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return m ? `+52 ${m[2]} ${m[3]} ${m[4]}` : phone;
}

/** Fecha corta en la zona horaria del negocio: "3 mar 2027". */
export function dateFormatter(timeZone: string) {
  const f = new Intl.DateTimeFormat("es-MX", { timeZone, day: "numeric", month: "short", year: "numeric" });
  return (d: string | Date | null | undefined) => (d ? f.format(new Date(d)).replace(/\./g, "") : "—");
}

export const money = (cents: number, currency = "MXN") =>
  (cents / 100).toLocaleString("es-MX", { style: "currency", currency, maximumFractionDigits: 0 });

export const percent = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

export const APPOINTMENT_STATUS: Record<string, { text: string; tone: Tone }> = {
  pending: { text: "Pendiente", tone: "amber" },
  confirmed: { text: "Confirmada", tone: "green" },
  done: { text: "Vino", tone: "sky" },
  no_show: { text: "No vino", tone: "rose" },
  cancelled: { text: "Cancelada", tone: "slate" },
};
