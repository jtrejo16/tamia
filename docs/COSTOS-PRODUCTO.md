# Costos del producto: lo que me cuesta darlo y lo que paga el cliente aparte

Fecha del cálculo: 18 de noviembre de 2026. Tipo de cambio usado: **$18 MXN por USD**. Todo es una **estimación para tomar decisiones**; donde no hay dato real, se marca. Los datos reales se verifican en la pantalla **Operador → Costos y rentabilidad** (ver [OPERADOR.md](OPERADOR.md)).

## 1. Resumen

- **Costo fijo de la plataforma:** ≈ **US$31 al mes (≈ $560 MXN)**, sin importar cuántos clientes haya. Un solo cliente del plan Esencial lo cubre.
- **El costo que crece con cada cliente es la IA.** Con el plan Esencial (modelo económico) es casi nada (≈ $12–95 MXN al mes). Con Profesional y Premium **puede comerse el margen si el cliente tiene mucho volumen**, a menos que se active el **ahorro por caché de prompts** (hoy NO está activado; ver sección 6).
- **Las llamadas (voz) no están en el precio de ningún plan** y son lo más caro por uso: ≈ **US$0.17–0.20 por minuto** (medido en tu cuenta de Retell). Hay que cobrarlas aparte o limitarlas.
- **Lo que el cliente paga aparte (a Meta, no a ti):** los mensajes de WhatsApp pasados los 1,000 gratis al mes por número y las plantillas de recordatorio. Con volumen mediano son ≈ US$9 al mes (≈ $170 MXN).

## 2. Datos reales que ya tenemos

| Concepto | Dato | Fuente |
|---|---|---|
| Número telefónico (DIDWW, Mérida) | **US$5 al mes** (renovación automática) + **US$5** de alta única | Tu cuenta de DIDWW (pedido DXU-424121) |
| Saldo en DIDWW | US$19.78 | Tu cuenta de DIDWW |
| Tokens por mensaje del cliente | ≈ **8,200 de entrada y 270 de salida** (6,317 + 211 por llamada al modelo, 1.3 llamadas por mensaje) | Medido en los datos de prueba del proyecto |
| Precio de los modelos (por millón de tokens, entrada / salida) | Económico (Haiku 5.5): **$0.10 / $0.50**; Balanceado (Sonnet 5.5): **$2 / $10**; Premium (Opus 5.5): **$4 / $20** | Tarifas de Anthropic |
| Precio de los planes (IVA incluido) | Esencial **$799**, Profesional **$1,499**, Premium **$2,999** | `packages/shared/src/plans.ts` |

## 3. Costos fijos mensuales (no dependen del número de clientes)

| Concepto | USD/mes | Notas |
|---|---|---|
| Railway (web, worker, base de datos, Redis) | ≈ 25–35 | Plan Pro (US$20, incluye US$20 de uso) y cobro por uso: ≈ US$20 por vCPU, US$10 por GB de RAM, US$0.15 por GB de disco y US$0.05 por GB de salida ([fuente](https://docs.railway.com/reference/pricing)). **Revisa tu factura real**; la cifra depende de la memoria que use cada servicio |
| Dominio `jovia.mx` | ≈ 1 | ≈ US$15 al año |
| **Total fijo base** | **≈ 31 (≈ $560 MXN)** | Se cubre con un solo cliente de Esencial |
| Número telefónico por cliente con llamadas | 5 + 5 de alta | Solo por cada cliente que quiera línea propia (DIDWW) |

Para llevar la cuenta exacta, define `COST_FIXED_MONTHLY_USD` (por ejemplo `{"Railway":30,"Dominio":1}`) y se reparte por los días del periodo en la pantalla de costos.

## 4. Costo variable por cliente

### 4.1 Mensajes con IA (WhatsApp, Messenger, Instagram)

Costo del modelo por **mensaje del cliente** (incluye el 5.5 % de comisión de OpenRouter y ≈ 8 % de resúmenes y otros usos internos):

| Plan / modelo | Sin caché | Con caché de prompts |
|---|---|---|
| Esencial (Haiku 5.5) | US$0.0011 | US$0.0004 |
| Profesional (Sonnet 5.5) | US$0.022 | US$0.007 |
| Premium (Opus 5.5) | US$0.044 | US$0.014 |

Tres escenarios de cliente (clínica dental), con 6 mensajes del cliente por conversación:

| Escenario | Conversaciones/mes | Mensajes del cliente | Citas/mes |
|---|---|---|---|
| Pequeña | 100 | 600 | 60 |
| Mediana | 300 | 1,800 | 150 |
| Grande | 800 | 4,800 | 400 |

**Costo de IA al mes y margen** (margen = precio sin IVA − comisión de Mercado Pago − IA; el IVA se quita porque el precio lo incluye; la comisión es ≈ 3.19 % + IVA):

| Plan | Escenario | IA sin caché | Margen sin caché | IA con caché | Margen con caché |
|---|---|---|---|---|---|
| Esencial ($799) | Pequeña | $12 | $647 (94 %) | $4 | $655 (95 %) |
| Esencial | Mediana | $35 | $624 (91 %) | $12 | $648 (94 %) |
| Esencial | Grande | $94 | $565 (82 %) | $31 | $628 (91 %) |
| Profesional ($1,499) | Pequeña | $236 | $1,001 (77 %) | $77 | $1,159 (90 %) |
| Profesional | Mediana | **$708** | **$529 (41 %)** | $232 | $1,004 (78 %) |
| Profesional | Grande | **$1,887** | **−$650 (pierdes)** | $620 | $617 (48 %) |
| Premium ($2,999) | Pequeña | $472 | $2,003 (77 %) | $155 | $2,319 (90 %) |
| Premium | Mediana | **$1,415** | **$1,059 (41 %)** | $465 | $2,009 (78 %) |
| Premium | Grande | **$3,774** | **−$1,299 (pierdes)** | $1,240 | $1,235 (48 %) |

(Cifras en pesos mexicanos al mes.) **Sin caché, un cliente grande en Profesional o Premium te hace perder dinero.**

### 4.2 Llamadas (voz), por minuto

**Datos reales de tu cuenta de Retell (leídos el 18-nov-2026, solo lectura):**

| Número / agente | Llamadas | Minutos | Costo total | Por llamada | Por minuto |
|---|---|---|---|---|---|
| +52 999 282 9059 · Clínica Dental Sonrisa (agente actual) | 11 | 5.2 | US$0.92 | US$0.084 | **US$0.178** |
| +52 999 282 9059 · Clínica Dental Sonrisa (agente anterior) | 9 | 2.9 | US$0.55 | US$0.062 | US$0.189 |
| Llamadas web de prueba · Sonrisa | 6 | 4.6 | US$0.74 | US$0.123 | US$0.160 |
| +1 224 261 7398 · Sofía Inmobiliaria (otro proyecto) | 5 | 14.6 | US$2.46 | US$0.492 | US$0.169 |

El costo real de Retell ronda **US$0.16–0.19 por minuto**. Se reparte en: motor de voz (≈ US$0.055/min), voz sintetizada (≈ US$0.015/min) y el modelo de lenguaje (lo más variable). Aparte de Retell se suma la telefonía de DIDWW (**US$0.01 por minuto iniciado**, medido) y el número (US$5 al mes).

**Datos reales de DIDWW (detalle de llamadas del número +52 999 282 9059, 16–18 nov):** 20 llamadas entrantes, todas conectadas, hacia Retell. Todas cobraron «Metered» (US$0.01 por minuto iniciado); ninguna cobró PSTN ni número gratuito. Las llamadas de más de un minuto (111 s y 97 s) costaron US$0.02; las demás, US$0.01. Total **US$0.22 (≈ $4 MXN)**; por día: 16-nov US$0.04, 17-nov US$0.13, 18-nov US$0.05. Coincide con tu saldo: pagaste US$30, el número costó US$10 (US$5 mensualidad + US$5 de alta) y quedan US$19.78.

**Estimación general usada en esta página:**

| Parte | USD/min | Notas |
|---|---|---|
| Retell (infraestructura de voz + modelo + voz) | ≈ 0.07–0.31 | Depende del modelo de lenguaje que use el agente ([fuente](https://www.developersdigest.tech/voice-agents/retell-ai)). **El costo real lo reporta Retell por llamada y ya se guarda** |
| Telefonía (DIDWW, entrada) | **0.01 por minuto iniciado** | **Medido** en el detalle de llamadas de DIDWW (20 llamadas, 16–18 nov): cada llamada cobra US$0.01 por cada minuto que empieza (redondea hacia arriba): US$0.22 en total por 8.1 minutos reales (22 facturados). Una llamada de 2–3 minutos cuesta US$0.02–0.03 |
| **Total estimado** | **≈ 0.17–0.20** (con los datos reales de Retell) | ≈ $3.1–3.6 MXN por minuto |

| Minutos al mes | Costo (0.17/min) | Costo (0.20/min) |
|---|---|---|
| 60 | $184 MXN | $216 MXN |
| 150 | $459 MXN | $540 MXN |
| 300 | $918 MXN | $1,080 MXN |

Una llamada típica de 3 minutos cuesta ≈ **$9–11 MXN**. Más el número de DIDWW ($5 USD/mes ≈ $90 MXN).

## 5. Costos adicionales que paga el cliente (aparte de tu plan)

Estos **los cobra Meta directamente al cliente**, porque cada negocio conecta su propio WhatsApp Business. Tienes que avisárselo al conectar el número.

| Concepto | Cuánto | Cuándo aplica |
|---|---|---|
| **Respuestas del asistente en WhatsApp (mensajes de servicio)** | Primeros **1,000 al mes por número: gratis**. Después, a la tarifa de utilidad de Meta (≈ US$0.0085 por mensaje, **estimado**: la tarifa de México está en los CSV de Meta, no en los .md) | Desde el 1 de octubre de 2026 ([PRICING.md](PRICING.md)) |
| **Recordatorios y confirmaciones de cita (plantillas de utilidad)** | ≈ US$0.0085 por plantilla (estimado). 2 por cita (24 h y 2 h antes) | Siempre |
| **Plantillas de marketing** (promociones, seguimiento) | Más caras (≈ US$0.04+, subieron el 1-oct-2026) | Solo si las usan |
| **Método de pago en Meta** | Obligatorio | **Sin método de pago, Meta deja de entregar mensajes después de los primeros 1,000 del mes** |
| **Número de teléfono para WhatsApp** | El de su línea (chip o fijo) | Debe poder recibir un código de verificación |
| Facebook, Instagram, Google Calendar | Gratis | — |
| IVA | Meta y tu plan lo cobran aparte/incluido según el caso | — |

**Cuánto es en la práctica (cliente mediano, 1,800 respuestas y 150 citas al mes):** (1,800 − 1,000) × US$0.0085 + 300 recordatorios × US$0.0085 ≈ **US$9.4 al mes (≈ $170 MXN)**. Un cliente pequeño paga ≈ US$1 al mes; uno grande, ≈ US$39 (≈ $700 MXN).

**Voz:** hoy **no está en los planes**. Si la incluyes, la pagas tú: conviene venderla como complemento (por ejemplo, paquete de 100 minutos) o cobrar el excedente.

## 6. Qué hacer con esto

1. **Activar la caché de prompts** en las llamadas al modelo (hoy no está). Baja el costo de IA ≈ **67 %** y es lo que hace rentables Profesional y Premium con volumen. Es el cambio de mayor impacto.
2. **Poner un tope de mensajes por plan** (por ejemplo, 1,000 conversaciones al mes en Profesional) o cobrar excedente, para que un cliente grande no vuelva negativo el margen.
3. **Cobrar la voz aparte** (paquete de minutos) o excluirla de Esencial.
4. **Avisar a cada cliente del cobro de Meta** y de que debe tener método de pago en Meta al conectar su número.
5. **Poner las tarifas reales de Meta (México, USD)** en `COST_RATES` y tus costos fijos en `COST_FIXED_MONTHLY_USD`; así la pantalla de costos muestra tu margen real por cliente.
6. **Revisar a un mes de uso real**: el cálculo usa tokens medidos en pruebas; con datos de producción (modo de pago, `LLM_MODE=paid`) las cifras se ajustan solas en Costos y rentabilidad.

### Llamadas más baratas (aplicado)

Al **sincronizar** el agente (Ajustes → Llamadas → Sincronizar, o desde el Operador), el sistema ahora le manda a Retell:
- **Modelo de lenguaje económico** (`RETELL_LLM_MODEL`, por defecto **`gpt-5.6-luna`**). Antes se usaba el modelo por defecto de Retell, de los más caros (≈ US$0.06 por minuto solo el modelo). Elegido con la tabla de comparación de Retell (capacidad 86.9 %, herramientas 88 %, 329 ms, **US$0.0064 por minuto**). Alternativas: `claude-5.5-haiku` (herramientas 90 %, aterrizado 92 %, US$0.0032, pero 742 ms), `gpt-6-luna` (80.7 %, US$0.0032), `gemini-3.1-flash-lite` (82.6 %, US$0.008); `default` para volver al de Retell. No usar `gpt-5-nano` (herramientas 60 %, capacidad 56 %): es muy barato pero falla al agendar.
- **Tope de duración** por llamada (`VOICE_MAX_CALL_MINUTES`, por defecto 10 min; Retell usa 60 por defecto).
- **Colgar tras silencio** (`VOICE_SILENCE_SECONDS`, por defecto 20 s; Retell usa 10 minutos por defecto).

**Medición real con el modelo nuevo (18-nov, dos llamadas de prueba de ≈ 48 s):**

| Concepto | `gpt-5.4-mini` | `gpt-5.6-luna` |
|---|---|---|
| Motor de voz (US$0.055/min) | 4.31¢ | 4.40¢ |
| Voz sintetizada (US$0.015/min) | 1.18¢ | 1.20¢ |
| Modelo de lenguaje | **1.88¢** (US$0.024/min) | **0.51¢** (US$0.0064/min) |
| Análisis posterior a la llamada (fijo por llamada) | 2.08¢ | 2.08¢ |
| **Total de la llamada** | **US$0.094** | **US$0.082** |
| Latencia del modelo (mediana) | 1,930 ms | **311 ms** (extremo a extremo 564 ms) |

Hallazgo: el **análisis posterior a la llamada** (resumen, sentimiento y «exitosa») cuesta **≈ US$0.021 FIJOS por llamada** con el modelo por defecto de Retell (`gpt-5.6-terra`), más que el propio modelo de la llamada. En llamadas cortas es el 25 % del costo. Por eso el sistema ahora también manda `RETELL_ANALYSIS_MODEL` (por defecto **`claude-5.5-haiku`**: en el panel de Retell, en «Post call extraction», aparece como **gratis**; verifícalo con el desglose de la próxima llamada). Si al medir cobra algo, alternativas: `gpt-5.6-luna` o `gpt-5-nano`.

**Llamada completa con la configuración final (18-nov, 1 min 48 s, cita reprogramada con éxito):** voz 9.9¢ + voz sintetizada 2.7¢ + modelo 1.15¢ = **US$0.1375** (7.6¢ por minuto) y **sin cargo de análisis** (con `claude-5.5-haiku` no aparece la línea). Más la telefonía de DIDWW (2 minutos iniciados = US$0.02): **≈ US$0.158 en total, ≈ US$0.088 por minuto**, frente a ≈ US$0.18 antes: **ahorro ≈ 50 %**. Latencia total ≈ 760 ms. El agente quedó con `gpt-5.6-luna`, tope de 10 min y 20 s de silencio (verificado en Retell).

Después de desplegar hay que **volver a sincronizar** cada agente y hacer una **llamada de prueba** (agendar una cita completa) para confirmar que el modelo chico sigue usando bien las herramientas. El efecto en el costo se ve en Retell por llamada (ya se guarda) y en Operador → Costos y rentabilidad.

## 7. Qué falta confirmar (no inventé)

- Tarifa de Meta para México (servicio, utilidad, marketing): bájala del CSV de Meta.
- Tarifa por minuto de DIDWW (entrada, «Pay Per Minute»): revisa su lista de precios.
- Costo real de Retell por minuto: **ya medido** (≈ US$0.16–0.19, ver 4.2). Con más llamadas reales se afina; el sistema lo guarda por llamada.
- Comisión exacta de Mercado Pago para suscripciones (se usó 3.19 % + IVA; confirma en tu cuenta).
- Factura real de Railway.
- Impuestos propios (ISR, facturación): no incluidos.
