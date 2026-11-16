# Propuesta Fase 1 — para aprobar antes de escribir código

Nombre clave del proyecto: `empleado-digital` (cámbialo cuando elijas {{NOMBRE_PRODUCTO}}).

## 1. Decisiones técnicas (las que no estaban cerradas en el prompt)

| Tema | Propuesta | Por qué |
|---|---|---|
| ORM | **Drizzle** | Soporta `vector` (pgvector) de forma nativa; con Prisma hay que usar SQL crudo para embeddings y RLS. |
| Auth | **Auth.js** (credenciales + Google) | Sin costo por usuario ni dependencia externa. Clerk es más rápido de montar pero cobra al crecer. |
| Estructura | **Monorepo pnpm** con `apps/web` y `apps/worker` | El worker (BullMQ) corre aparte del panel; comparten paquetes. |
| Multi-tenant | `tenant_id` en toda tabla + **Row Level Security** | Cada transacción hace `SET LOCAL app.tenant_id = '<uuid>'`. Hay prueba automática de aislamiento. |
| Webhook WhatsApp | Ruta en `apps/web`, valida `X-Hub-Signature-256`, responde 200 y encola | Todo lo pesado ocurre en el worker. |
| Credenciales | AES-256-GCM, llave en `ENCRYPTION_KEY` | Tokens de WhatsApp y OAuth de Google. |
| Embeddings | Un solo modelo fijo para toda la plataforma (se define al implementar RAG) | Cambiarlo obliga a re-vectorizar todo. |
| Dinero | Precios en centavos (`integer`) + `currency` | Evita errores de redondeo. |
| Fechas | `timestamptz` en UTC; zona horaria en `tenants.timezone` | Quintana Roo y Yucatán no comparten hora. |

## 2. Esquema de base de datos

Convención: todas las tablas llevan `id uuid pk`, `created_at`, `updated_at`. Las marcadas con (T) llevan `tenant_id` y RLS.

**Núcleo**
- `tenants`: name, slug, vertical (`dental|seguros|...`), timezone, plan, status, locale, privacy_notice_url, human_hours (jsonb).
- `users`: email, name, password_hash? — global, sin tenant.
- `memberships` (T): user_id, role (`owner|agent|viewer`). Un usuario puede pertenecer a varios negocios.
- `audit_log` (T): user_id, action, entity, entity_id, diff (jsonb).

**Canales y agente**
- `channels` (T): type (`whatsapp|...`), external_id (**`phone_number_id`**, único global: mapea webhook → tenant), waba_id, display_phone, credentials_enc (bytea), status, quality_rating, meta (jsonb).
- `agent_configs` (T): assistant_name, tone, formality (`tu|usted`), model, fallback_model, temperature, autonomy (`copilot|semi|auto`), escalation_rules (jsonb), forbidden_topics (jsonb), pack_slug, pack_version.
- `templates` (T): channel_id, name, language, category (`utility|marketing|authentication`), components (jsonb), status, meta_template_id.

**Contactos y conversaciones**
- `contacts` (T): display_name, phone_e164, email, tags (text[]), profile (jsonb: hechos durables), opt_in_marketing (bool + fecha), opted_out_at.
- `conversations` (T): contact_id, channel_id, state (`bot|human|closed`), assigned_user_id, last_inbound_at (para la ventana de 24 h), last_message_at, task_state (jsonb: slot filling).
- `messages` (T): conversation_id, direction (`in|out`), sender (`contact|bot|human`), type (`text|audio|image|location|template|interactive|document`), body, media_url, transcript, external_id (**único por canal → idempotencia**), status (`queued|sent|delivered|read|failed`), error, tokens_in, tokens_out.
- `conversation_memory` (T): conversation_id, summary, summarized_up_to_message_id.

**Negocio y agenda**
- `services` (T): name, description, duration_min, buffer_min, price_cents, currency, requires_deposit, active.
- `staff` (T): name, role_label, calendar_provider, calendar_id, credentials_enc, active.
- `staff_services` (T): staff_id, service_id.
- `business_hours` (T): staff_id nullable (null = negocio), weekday, opens, closes.
- `business_holidays` (T): staff_id nullable, date, reason.
- `appointments` (T): contact_id, service_id, staff_id, starts_at, ends_at, status (`pending|confirmed|cancelled|no_show|done`), calendar_event_id, reminder_24h_sent_at, reminder_2h_sent_at, confirmed_by_contact (bool), source_conversation_id.
  - Índice de exclusión `(staff_id, tstzrange(starts_at, ends_at))` para impedir traslapes aunque falle el lock de Redis.

**Conocimiento y entrenamiento**
- `knowledge_docs` (T): title, source_type, file_url, status.
- `knowledge_chunks` (T): doc_id, content, embedding `vector(N)`, índice HNSW.
- `approvals` (T): conversation_id, draft, final_text, status (`pending|approved|edited|discarded`), reviewed_by, reviewed_at.
- `handoffs` (T): conversation_id, reason, urgency, notified_at, taken_by, resolved_at.

**Costos**
- `usage_events` (T): kind (`llm|whatsapp|embedding|transcription`), model, tokens_in, tokens_out, cost_usd_micros, ref_message_id.

## 3. Estructura de carpetas

```
empleado-digital/
├─ apps/
│  ├─ web/                      Next.js 15 (panel + API + webhooks)
│  │  └─ src/app/
│  │     ├─ (auth)/login
│  │     ├─ (panel)/inbox        bandeja en tiempo real
│  │     ├─ (panel)/approvals    borradores pendientes
│  │     ├─ (panel)/settings     negocio, horarios, servicios, equipo, políticas, FAQs, docs
│  │     ├─ (panel)/playground   probador del agente
│  │     └─ api/webhooks/whatsapp/route.ts
│  └─ worker/                   BullMQ: inbound, outbound, reminders, indexing, summarize
├─ packages/
│  ├─ db/                        Drizzle: schema, migraciones, RLS, seed (tenant demo)
│  ├─ agent/                     Agent Runtime: prompt builder, memoria, loop de tools, política de salida
│  │  └─ tools/                  una carpeta por herramienta con esquema JSON
│  ├─ channels/                  ChannelAdapter + whatsapp/ (cliente Cloud API, firma, parser, ventana 24 h)
│  ├─ llm/                       LLMProvider + openrouter/ (lista blanca de modelos, fallback)
│  ├─ calendar/                  CalendarProvider + google/
│  ├─ scheduling/                lógica de disponibilidad (duración, buffers, festivos) — sin LLM
│  ├─ knowledge/                 parseo PDF/DOCX/TXT, troceo, embeddings, búsqueda
│  └─ shared/                    tipos, cifrado AES-GCM, config, logger
├─ packs/                       dental.json, seguros.json (versionados)
├─ evals/                       dental/*.yaml, seguros/*.yaml + runner
├─ docker-compose.yml           postgres+pgvector, redis
├─ .env.example
└─ README.md
```

## 4. Orden de trabajo dentro de la Fase 1 (pasos pequeños)

1. Monorepo, Docker Compose, `.env.example`.
2. `db`: esquema, migraciones, RLS + prueba de aislamiento entre tenants, seed "Clínica Dental Sonrisa".
3. `shared` (cifrado) y `scheduling` con pruebas unitarias.
4. `llm` (OpenRouter) + `agent` + herramientas + probador en el panel (aún sin WhatsApp).
5. `channels/whatsapp`: webhook, cola, envío, ventana 24 h.
6. Aprobaciones y bandeja con "Tomar control".
7. Google Calendar.
8. Conocimiento (RAG).
9. Recordatorios y audios.
10. Evals.

## 5. Pendientes que necesito de ti

- Nombre del producto.
- Instalar: Node.js LTS, pnpm, Git y Docker Desktop (el equipo tiene ~8 GB de RAM; Docker irá justo, ver README cuando exista).
- API key de OpenRouter.
- Qué número usar para la demo dental: el +52 984 479 0350 ya está registrado, pero su nombre visible es "Renova Capital".
