-- Costos de WhatsApp reales: cada mensaje saliente guarda la categoria y si Meta lo cobra (aviso de estado de Meta).
-- Meta cobra desde el 1-oct-2026 tambien los mensajes de servicio (respuestas dentro de las 24 h) pasados los primeros
-- 1,000 al mes por numero, y los de utilidad dentro de la ventana.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pricing_category text;
--> statement-breakpoint
ALTER TABLE messages ADD COLUMN IF NOT EXISTS billable boolean;
--> statement-breakpoint

DROP FUNCTION IF EXISTS operator_costs(timestamptz, timestamptz);
--> statement-breakpoint

CREATE FUNCTION operator_costs(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  tenant_id uuid,
  ai_micros bigint, ai_tokens_in bigint, ai_tokens_out bigint,
  call_count integer, call_seconds bigint, call_recorded_micros bigint, call_unpriced_seconds bigint,
  tpl_marketing integer, tpl_utility integer, tpl_authentication integer, tpl_unknown integer, svc_legacy integer,
  billed_marketing integer, billed_utility integer, billed_authentication integer, billed_service integer, billed_other integer,
  wa_in integer, wa_out integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT app_is_operator() THEN
    RAISE EXCEPTION 'no autorizado';
  END IF;
  RETURN QUERY
  SELECT
    t.id,
    coalesce((SELECT sum(u.cost_usd_micros) FROM usage_events u WHERE u.tenant_id = t.id AND u.created_at >= p_from AND u.created_at < p_to), 0)::bigint,
    coalesce((SELECT sum(u.tokens_in) FROM usage_events u WHERE u.tenant_id = t.id AND u.created_at >= p_from AND u.created_at < p_to), 0)::bigint,
    coalesce((SELECT sum(u.tokens_out) FROM usage_events u WHERE u.tenant_id = t.id AND u.created_at >= p_from AND u.created_at < p_to), 0)::bigint,
    (SELECT count(*)::int FROM calls c WHERE c.tenant_id = t.id AND coalesce(c.started_at, c.created_at) >= p_from AND coalesce(c.started_at, c.created_at) < p_to),
    coalesce((SELECT sum(c.duration_seconds) FROM calls c WHERE c.tenant_id = t.id AND coalesce(c.started_at, c.created_at) >= p_from AND coalesce(c.started_at, c.created_at) < p_to), 0)::bigint,
    coalesce((SELECT sum(c.cost_usd_micros) FROM calls c WHERE c.tenant_id = t.id AND coalesce(c.started_at, c.created_at) >= p_from AND coalesce(c.started_at, c.created_at) < p_to), 0)::bigint,
    coalesce((SELECT sum(c.duration_seconds) FROM calls c WHERE c.tenant_id = t.id AND c.cost_usd_micros IS NULL AND coalesce(c.started_at, c.created_at) >= p_from AND coalesce(c.started_at, c.created_at) < p_to), 0)::bigint,
    coalesce(tp.marketing, 0), coalesce(tp.utility, 0), coalesce(tp.authentication, 0), coalesce(tp.unknown, 0),
    coalesce(wa.svc_legacy, 0),
    coalesce(wa.b_marketing, 0), coalesce(wa.b_utility, 0), coalesce(wa.b_authentication, 0), coalesce(wa.b_service, 0), coalesce(wa.b_other, 0),
    coalesce(wa.n_in, 0), coalesce(wa.n_out, 0)
  FROM tenants t
  -- Plantillas enviadas SIN dato de Meta todavia: se clasifican por la categoria de la plantilla usada (estimado).
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE x.category = 'marketing')::int AS marketing,
      count(*) FILTER (WHERE x.category = 'utility')::int AS utility,
      count(*) FILTER (WHERE x.category = 'authentication')::int AS authentication,
      count(*) FILTER (WHERE x.category IS NULL)::int AS unknown
    FROM (
      SELECT (SELECT tpl.category::text FROM templates tpl WHERE tpl.tenant_id = m.tenant_id AND tpl.name = substring(m.body from '"name":"([^"]+)"') LIMIT 1) AS category
      FROM messages m
      JOIN channels ch ON ch.id = m.channel_id AND ch.type = 'whatsapp'
      WHERE m.tenant_id = t.id AND m.type = 'template' AND m.direction = 'out' AND m.pricing_category IS NULL
        AND m.status IN ('sent','delivered','read') AND m.created_at >= p_from AND m.created_at < p_to
    ) x
  ) tp ON true
  LEFT JOIN LATERAL (
    SELECT
      -- Respuestas (no plantilla) SIN dato de Meta todavia: se estiman como mensajes de servicio.
      count(*) FILTER (WHERE m.direction = 'out' AND m.type <> 'template' AND m.pricing_category IS NULL AND m.status IN ('sent','delivered','read'))::int AS svc_legacy,
      -- Con dato de Meta: se cuentan los que Meta SI cobra, por categoria (el monto sale de la tarifa).
      count(*) FILTER (WHERE m.direction = 'out' AND m.billable AND m.pricing_category = 'marketing')::int AS b_marketing,
      count(*) FILTER (WHERE m.direction = 'out' AND m.billable AND m.pricing_category = 'utility')::int AS b_utility,
      count(*) FILTER (WHERE m.direction = 'out' AND m.billable AND m.pricing_category LIKE 'authentication%')::int AS b_authentication,
      count(*) FILTER (WHERE m.direction = 'out' AND m.billable AND m.pricing_category = 'service')::int AS b_service,
      count(*) FILTER (WHERE m.direction = 'out' AND m.billable AND m.pricing_category NOT IN ('marketing','utility','service') AND m.pricing_category NOT LIKE 'authentication%')::int AS b_other,
      count(*) FILTER (WHERE m.direction = 'in')::int AS n_in,
      count(*) FILTER (WHERE m.direction = 'out' AND m.status IN ('sent','delivered','read'))::int AS n_out
    FROM messages m
    JOIN channels ch ON ch.id = m.channel_id AND ch.type = 'whatsapp'
    WHERE m.tenant_id = t.id AND m.created_at >= p_from AND m.created_at < p_to
  ) wa ON true
  ORDER BY t.created_at DESC;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION operator_costs(timestamptz, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operator_costs(timestamptz, timestamptz) TO empleado_app;
