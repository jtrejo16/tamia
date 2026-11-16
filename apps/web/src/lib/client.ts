"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface ApiError {
  ok: false;
  error: string;
  message: string;
  details?: string[];
}

/** Llama a la API del panel. Si la sesion termino, lleva al inicio de sesion. */
export async function api<T extends { ok: true }>(
  url: string,
  options: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {},
): Promise<T | ApiError> {
  try {
    const res = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.body === undefined ? undefined : { "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      cache: "no-store",
    });
    const json = (await res.json().catch(() => null)) as (T | ApiError) | null;
    if (res.status === 401 && typeof window !== "undefined" && !url.startsWith("/api/auth/")) {
      window.location.href = "/login";
    }
    return json ?? { ok: false, error: "server_error", message: "Respuesta inesperada del servidor." };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    return { ok: false, error: "network", message: "Sin conexión con el servidor. Reintentando…" };
  }
}

/**
 * Consulta periodica: se pausa cuando la pestana no esta visible y evita peticiones
 * encimadas. `key` null = desactivada.
 */
export function usePolling<T extends { ok: true }>(url: string | null, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const inFlight = useRef(false);
  /** Se pidio recargar mientras ya habia una consulta: se repite al terminar, para no mostrar datos viejos. */
  const again = useRef(false);
  const current = useRef(url);
  current.current = url;

  const load = useCallback(async (): Promise<void> => {
    const target = current.current;
    if (!target) return;
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const res = await api<T>(target);
      if (current.current !== target) return; // cambio de pantalla mientras cargaba
      if (res.ok) {
        setData(res);
        setError(null);
      } else {
        setError(res);
      }
    } catch {
      /* abortado */
    } finally {
      inFlight.current = false;
      setLoading(false);
      if (again.current) {
        again.current = false;
        void load();
      }
    }
  }, []);

  useEffect(() => {
    setData(null);
    setError(null);
    setLoading(Boolean(url));
    if (!url) return;
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, intervalMs);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url, intervalMs, load]);

  return { data, error, loading, reload: load };
}

// ---------------------------------------------------------------- fechas

export function makeFormatters(timeZone: string) {
  const time = new Intl.DateTimeFormat("es-MX", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false });
  const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dayLong = new Intl.DateTimeFormat("es-MX", { timeZone, weekday: "long", day: "numeric", month: "long" });
  const dayShort = new Intl.DateTimeFormat("es-MX", { timeZone, day: "numeric", month: "short" });

  const key = (d: Date) => dayKey.format(d);
  return {
    time: (d: Date | string) => time.format(new Date(d)),
    dayKey: (d: Date | string) => key(new Date(d)),
    /** "Hoy", "Ayer" o "martes 2 de marzo" */
    dayLabel(d: Date | string, now = new Date()): string {
      const date = new Date(d);
      const today = key(now);
      if (key(date) === today) return "Hoy";
      if (key(date) === key(new Date(now.getTime() - 86_400_000))) return "Ayer";
      if (key(date) === key(new Date(now.getTime() + 86_400_000))) return "Mañana";
      const label = dayLong.format(date);
      return label.charAt(0).toUpperCase() + label.slice(1);
    },
    /** Hora si es de hoy; si no, "2 mar" */
    short(d: Date | string, now = new Date()): string {
      const date = new Date(d);
      return key(date) === key(now) ? time.format(date) : dayShort.format(date);
    },
  };
}

/** "5 h 12 min", "38 min"; null si ya paso. */
export function timeLeft(until: Date | string | null, now = new Date()): string | null {
  if (!until) return null;
  const ms = new Date(until).getTime() - now.getTime();
  if (ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}
