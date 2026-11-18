/**
 * Costos de operar la plataforma, en dolares (USD). Lo que se puede MEDIR se mide (IA: costo real de OpenRouter;
 * llamadas: costo real que reporta Retell). Lo que no (mensajes de WhatsApp de Meta, telefonia) se ESTIMA con
 * tarifas editables: Meta y los proveedores cambian precios, asi que se pueden ajustar con la variable COST_RATES.
 */

export interface CostRates {
  /** Cargo de Meta por plantilla enviada (USD), segun categoria. Los mensajes de servicio (respuestas dentro de 24 h) no cuestan. */
  whatsapp: { marketing: number; utility: number; authentication: number };
  /** Telefonia (troncal SIP / DIDWW) por minuto de llamada (USD), solo cuando Retell no reporta su propio costo. */
  phonePerMinute: number;
  /** Costo por minuto de Retell si no reporto el costo de una llamada (USD). */
  retellFallbackPerMinute: number;
}

export interface FixedCost {
  name: string;
  /** USD por mes. */
  usdMonthly: number;
}

export interface CostConfig {
  rates: CostRates;
  /** Costos fijos mensuales de la plataforma (servidor, numero telefonico, dominio...). */
  fixed: FixedCost[];
  /** Pesos por dolar para comparar contra lo que cobra la plataforma (MXN). */
  usdMxn: number;
}

/** Tarifas por defecto (Mexico). SON ESTIMACIONES: revisa la tabla de precios de Meta y ajusta con COST_RATES. */
export const DEFAULT_RATES: CostRates = {
  whatsapp: { marketing: 0.0436, utility: 0.0085, authentication: 0.0085 },
  phonePerMinute: 0.015,
  retellFallbackPerMinute: 0.09,
};

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/**
 * Lee la configuracion de costos del entorno:
 *  - COST_RATES: JSON parcial, p. ej. {"whatsapp":{"marketing":0.05},"phonePerMinute":0.02}
 *  - COST_FIXED_MONTHLY_USD: JSON {"Railway":20,"Numero DIDWW":3}
 *  - USD_MXN: tipo de cambio (por defecto 18)
 * Un valor mal escrito se ignora (nunca rompe la pantalla).
 */
export function costConfigFromEnv(env: Record<string, string | undefined>): CostConfig {
  const rates: CostRates = { ...DEFAULT_RATES, whatsapp: { ...DEFAULT_RATES.whatsapp } };
  try {
    const raw = env.COST_RATES?.trim() ? (JSON.parse(env.COST_RATES) as Record<string, unknown>) : {};
    const wa = (raw.whatsapp ?? {}) as Record<string, unknown>;
    rates.whatsapp.marketing = num(wa.marketing) ?? rates.whatsapp.marketing;
    rates.whatsapp.utility = num(wa.utility) ?? rates.whatsapp.utility;
    rates.whatsapp.authentication = num(wa.authentication) ?? rates.whatsapp.authentication;
    rates.phonePerMinute = num(raw.phonePerMinute) ?? rates.phonePerMinute;
    rates.retellFallbackPerMinute = num(raw.retellFallbackPerMinute) ?? rates.retellFallbackPerMinute;
  } catch {
    /* JSON invalido: se usan las tarifas por defecto */
  }

  const fixed: FixedCost[] = [];
  try {
    const raw = env.COST_FIXED_MONTHLY_USD?.trim() ? (JSON.parse(env.COST_FIXED_MONTHLY_USD) as Record<string, unknown>) : {};
    for (const [name, v] of Object.entries(raw)) {
      const usd = num(v);
      if (usd !== undefined && name.trim()) fixed.push({ name: name.trim().slice(0, 60), usdMonthly: usd });
    }
  } catch {
    /* igual */
  }

  const fx = Number(env.USD_MXN);
  return { rates, fixed, usdMxn: Number.isFinite(fx) && fx > 5 && fx < 100 ? fx : 18 };
}

/** Lo que un negocio consumio en el periodo (conteos y costos ya medidos). */
export interface TenantUsage {
  aiMicros: number;
  callSeconds: number;
  /** Costo real reportado por Retell (micro-USD) de las llamadas que lo traen. */
  callRecordedMicros: number;
  /** Segundos de llamadas SIN costo reportado (se estiman). */
  callUnpricedSeconds: number;
  tplMarketing: number;
  tplUtility: number;
  tplAuthentication: number;
  /** Plantillas cuyo nombre no se encontro (se cobran como utilidad). */
  tplUnknown: number;
}

export interface TenantCost {
  aiUsd: number;
  /** Retell (voz): real + estimado de las llamadas sin costo reportado. */
  voiceUsd: number;
  /** Telefonia (troncal) por minuto. */
  phoneUsd: number;
  /** Cargo estimado de Meta por plantillas. */
  whatsappUsd: number;
  totalUsd: number;
  /** Parte del total que es estimada (no medida). */
  estimatedUsd: number;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function priceTenant(u: TenantUsage, rates: CostRates): TenantCost {
  const aiUsd = u.aiMicros / 1e6;
  const voiceReal = u.callRecordedMicros / 1e6;
  const voiceEst = (u.callUnpricedSeconds / 60) * rates.retellFallbackPerMinute;
  const phoneUsd = (u.callSeconds / 60) * rates.phonePerMinute;
  const whatsappUsd =
    u.tplMarketing * rates.whatsapp.marketing + (u.tplUtility + u.tplUnknown) * rates.whatsapp.utility + u.tplAuthentication * rates.whatsapp.authentication;
  const voiceUsd = voiceReal + voiceEst;
  return {
    aiUsd: round6(aiUsd),
    voiceUsd: round6(voiceUsd),
    phoneUsd: round6(phoneUsd),
    whatsappUsd: round6(whatsappUsd),
    totalUsd: round6(aiUsd + voiceUsd + phoneUsd + whatsappUsd),
    estimatedUsd: round6(voiceEst + phoneUsd + whatsappUsd),
  };
}
