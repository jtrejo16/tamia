/**
 * Costos de operar la plataforma, en dolares (USD). Lo que se puede MEDIR se mide (IA: costo real de OpenRouter;
 * llamadas: costo real que reporta Retell; WhatsApp: Meta avisa por mensaje si se cobra y en que categoria). Lo que
 * no (el MONTO por mensaje de Meta, la telefonia) se ESTIMA con tarifas editables con la variable COST_RATES.
 *
 * Meta (desde el 1-oct-2026): cobra por mensaje ENTREGADO de la empresa al cliente, segun categoria: marketing,
 * utilidad, autenticacion y SERVICIO (cualquier respuesta no-plantilla dentro de las 24 h, la IA incluida). Los primeros
 * 1,000 mensajes de servicio al mes por numero son gratis; despues se cobran a la tarifa de utilidad/autenticacion.
 * Los mensajes del cliente al negocio no se cobran. Ver docs/PRICING.md.
 */

export interface CostRates {
  /** Cargo de Meta por mensaje entregado (USD), segun categoria. `service` = respuestas dentro de las 24 h. */
  whatsapp: { marketing: number; utility: number; authentication: number; service: number };
  /** Mensajes de servicio gratis al mes por numero de WhatsApp. */
  serviceFreePerMonth: number;
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

/**
 * Tarifas por defecto (Mexico). SON ESTIMACIONES, no la tabla de Meta: descarga la de Mexico (USD) en
 * developers.facebook.com/documentation/business-messaging/whatsapp/pricing y ajusta con COST_RATES.
 * Meta cobra el servicio a la misma tarifa que utilidad/autenticacion.
 */
export const DEFAULT_RATES: CostRates = {
  whatsapp: { marketing: 0.0436, utility: 0.0085, authentication: 0.0085, service: 0.0085 },
  serviceFreePerMonth: 1000,
  phonePerMinute: 0.015,
  retellFallbackPerMinute: 0.09,
};

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/**
 * Lee la configuracion de costos del entorno:
 *  - COST_RATES: JSON parcial, p. ej. {"whatsapp":{"marketing":0.05,"service":0.01},"phonePerMinute":0.02}
 *  - COST_FIXED_MONTHLY_USD: JSON {"Railway":20,"Numero DIDWW":3}
 *  - USD_MXN: tipo de cambio (por defecto 18)
 * Un valor mal escrito se ignora (nunca rompe la pantalla). Si no pones `service`, se usa la tarifa de utilidad.
 */
export function costConfigFromEnv(env: Record<string, string | undefined>): CostConfig {
  const rates: CostRates = { ...DEFAULT_RATES, whatsapp: { ...DEFAULT_RATES.whatsapp } };
  try {
    const raw = env.COST_RATES?.trim() ? (JSON.parse(env.COST_RATES) as Record<string, unknown>) : {};
    const wa = (raw.whatsapp ?? {}) as Record<string, unknown>;
    rates.whatsapp.marketing = num(wa.marketing) ?? rates.whatsapp.marketing;
    rates.whatsapp.utility = num(wa.utility) ?? rates.whatsapp.utility;
    rates.whatsapp.authentication = num(wa.authentication) ?? rates.whatsapp.authentication;
    rates.whatsapp.service = num(wa.service) ?? num(wa.utility) ?? rates.whatsapp.service;
    rates.serviceFreePerMonth = num(raw.serviceFreePerMonth) ?? rates.serviceFreePerMonth;
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
  /** Plantillas SIN dato de Meta aun (estimado por la categoria de la plantilla). */
  tplMarketing: number;
  tplUtility: number;
  tplAuthentication: number;
  /** Plantillas cuyo nombre no se encontro (se cobran como utilidad). */
  tplUnknown: number;
  /** Respuestas (no plantilla) SIN dato de Meta aun: se estiman como mensajes de servicio. */
  svcLegacy: number;
  /** Mensajes con dato de Meta que SI se cobran, por categoria (conteo real). */
  billedMarketing: number;
  billedUtility: number;
  billedAuthentication: number;
  billedService: number;
  billedOther: number;
  /** Mensajes de servicio gratis que aplican a este periodo (1,000 por mes por numero; proporcional si el periodo no es un mes). */
  svcFreeTier: number;
}

export interface TenantCost {
  aiUsd: number;
  /** Retell (voz): real + estimado de las llamadas sin costo reportado. */
  voiceUsd: number;
  /** Telefonia (troncal) por minuto. */
  phoneUsd: number;
  /** Cargo de Meta por mensajes (plantillas y respuestas de servicio). */
  whatsappUsd: number;
  totalUsd: number;
  /** Parte del total que es estimada (no medida). */
  estimatedUsd: number;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function priceTenant(u: TenantUsage, rates: CostRates): TenantCost {
  const wa = rates.whatsapp;
  const aiUsd = u.aiMicros / 1e6;
  const voiceReal = u.callRecordedMicros / 1e6;
  const voiceEst = (u.callUnpricedSeconds / 60) * rates.retellFallbackPerMinute;
  const phoneUsd = (u.callSeconds / 60) * rates.phonePerMinute;

  // Mensajes con dato de Meta: se sabe CUALES se cobran (conteo real); solo el monto sale de la tarifa.
  const billed =
    u.billedMarketing * wa.marketing + u.billedUtility * wa.utility + u.billedAuthentication * wa.authentication + (u.billedService + u.billedOther) * wa.service;
  // Mensajes sin dato de Meta (anteriores a este registro o aun sin aviso): plantillas por su categoria y respuestas
  // como servicio, pasados los gratis del mes.
  const templatesEst = u.tplMarketing * wa.marketing + (u.tplUtility + u.tplUnknown) * wa.utility + u.tplAuthentication * wa.authentication;
  const serviceEst = Math.max(0, u.svcLegacy - Math.max(0, u.svcFreeTier - u.billedService)) * wa.service;
  const whatsappUsd = billed + templatesEst + serviceEst;

  const voiceUsd = voiceReal + voiceEst;
  return {
    aiUsd: round6(aiUsd),
    voiceUsd: round6(voiceUsd),
    phoneUsd: round6(phoneUsd),
    whatsappUsd: round6(whatsappUsd),
    totalUsd: round6(aiUsd + voiceUsd + phoneUsd + whatsappUsd),
    // El monto de Meta siempre es estimado (la tarifa la pones tu), aunque el conteo sea real.
    estimatedUsd: round6(voiceEst + phoneUsd + whatsappUsd),
  };
}
