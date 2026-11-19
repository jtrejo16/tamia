-- Avisos al equipo (cuando alguien pide una persona) y solicitud de resena despues de la cita.
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'otro';
--> statement-breakpoint
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS notify_attempts integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Las escalaciones que ya existen NO se avisan (solo las nuevas).
UPDATE handoffs SET notified_at = now() WHERE notified_at IS NULL;
--> statement-breakpoint
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS review_requested_at timestamptz;
--> statement-breakpoint

CREATE TABLE notification_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'business_hours',
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_settings_tenant_id_unique UNIQUE (tenant_id)
);
--> statement-breakpoint
CREATE TABLE review_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  hours_after integer NOT NULL DEFAULT 3,
  platform text NOT NULL DEFAULT 'google',
  url text,
  enabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_settings_tenant_id_unique UNIQUE (tenant_id)
);
--> statement-breakpoint

-- Aislamiento por negocio.
ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON notification_settings
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
ALTER TABLE review_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE review_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON review_settings
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_settings, review_settings TO empleado_app;
--> statement-breakpoint

-- Escalaciones que toca avisar al equipo: de negocios activos con avisos encendidos y destinatarios. Cruza negocios
-- (SECURITY DEFINER) pero solo devuelve ids; el worker trabaja cada negocio bajo su aislamiento.
CREATE FUNCTION handoffs_to_notify(p_limit integer)
RETURNS TABLE (tenant_id uuid, handoff_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT h.tenant_id, h.id
  FROM handoffs h
  JOIN notification_settings n ON n.tenant_id = h.tenant_id AND n.enabled
  JOIN tenants t ON t.id = h.tenant_id AND t.status = 'active'
  WHERE h.notified_at IS NULL AND h.resolved_at IS NULL AND h.notify_attempts < 5
    AND h.created_at > now() - interval '2 days'
    AND (h.kind IN ('pidio_persona', 'urgencia', 'queja') OR h.urgency = 'alta')
    AND jsonb_array_length(n.recipients) > 0
  ORDER BY h.created_at
  LIMIT p_limit
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION handoffs_to_notify(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION handoffs_to_notify(integer) TO empleado_app;
--> statement-breakpoint

-- Citas a las que toca pedirles resena: la cita termino hace al menos N horas (y no hace mas de 3 dias), despues de que
-- se encendio la funcion, y no se ha pedido. Los demas filtros (telefono, baja, 90 dias) los aplica el worker.
CREATE FUNCTION reviews_due(p_now timestamptz, p_limit integer)
RETURNS TABLE (tenant_id uuid, appointment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.tenant_id, a.id
  FROM appointments a
  JOIN review_settings r ON r.tenant_id = a.tenant_id AND r.enabled AND r.url IS NOT NULL
  JOIN tenants t ON t.id = a.tenant_id AND t.status = 'active'
  WHERE a.review_requested_at IS NULL
    AND a.status IN ('confirmed', 'done')
    AND a.ends_at + make_interval(hours => r.hours_after) <= p_now
    AND a.ends_at > p_now - interval '3 days'
    AND a.ends_at >= coalesce(r.enabled_at, p_now)
  ORDER BY a.ends_at
  LIMIT p_limit
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION reviews_due(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION reviews_due(timestamptz, integer) TO empleado_app;
