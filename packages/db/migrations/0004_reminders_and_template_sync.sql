-- Recordatorios de cita: que citas necesitan aviso AHORA, mirando todos los negocios a la vez
-- (por eso SECURITY DEFINER; solo devuelve ids). Reglas:
--   24 h: entre 24 y 3 h antes, solo si la cita se agendo con mas de 24 h de anticipacion
--         (si la agendaron hace unas horas, el cliente ya lo sabe) y si es horario diurno.
--   2 h : entre 2 h y 20 min antes.
--   Nunca de noche: solo entre las 08:00 y las 20:59, hora del negocio.
-- El envio marca reminder_*_sent_at con un UPDATE condicional, asi dos procesos no duplican.
CREATE OR REPLACE FUNCTION due_reminders(p_now timestamptz, p_limit integer DEFAULT 100)
RETURNS TABLE (tenant_id uuid, appointment_id uuid, kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.tenant_id, r.appointment_id, r.kind
  FROM (
    SELECT a.tenant_id, a.id AS appointment_id, '24h'::text AS kind, a.starts_at
    FROM appointments a
    JOIN tenants t ON t.id = a.tenant_id
    WHERE t.status = 'active'
      AND a.status IN ('pending', 'confirmed')
      AND a.reminder_24h_sent_at IS NULL
      AND a.starts_at >  p_now + interval '3 hours'
      AND a.starts_at <= p_now + interval '24 hours'
      AND a.created_at < a.starts_at - interval '24 hours'
      AND extract(hour FROM (p_now AT TIME ZONE t.timezone)) BETWEEN 8 AND 20
    UNION ALL
    SELECT a.tenant_id, a.id, '2h'::text, a.starts_at
    FROM appointments a
    JOIN tenants t ON t.id = a.tenant_id
    WHERE t.status = 'active'
      AND a.status IN ('pending', 'confirmed')
      AND a.reminder_2h_sent_at IS NULL
      AND a.starts_at >  p_now + interval '20 minutes'
      AND a.starts_at <= p_now + interval '2 hours'
      AND extract(hour FROM (p_now AT TIME ZONE t.timezone)) BETWEEN 8 AND 20
  ) r
  ORDER BY r.starts_at, r.kind
  LIMIT p_limit
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION due_reminders(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION due_reminders(timestamptz, integer) TO empleado_app;
--> statement-breakpoint

-- Canales de WhatsApp con cuenta conocida: el worker sincroniza el estado de sus plantillas.
CREATE OR REPLACE FUNCTION channels_for_template_sync()
RETURNS TABLE (tenant_id uuid, channel_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.tenant_id, c.id
  FROM channels c
  JOIN tenants t ON t.id = c.tenant_id
  WHERE c.type = 'whatsapp' AND c.status = 'active' AND c.waba_id IS NOT NULL
    AND c.credentials_enc IS NOT NULL AND t.status = 'active'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION channels_for_template_sync() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION channels_for_template_sync() TO empleado_app;
