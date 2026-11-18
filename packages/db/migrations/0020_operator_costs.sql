-- Costos por negocio: costo real de cada llamada (lo reporta Retell) y resumen de consumo para el operador.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS cost_usd_micros integer;
--> statement-breakpoint

-- Consumo de TODOS los negocios en un periodo [p_from, p_to). Solo responde al operador; no devuelve claves ni contenido.
CREATE FUNCTION operator_costs(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  tenant_id uuid,
  ai_micros bigint, ai_tokens_in bigint, ai_tokens_out bigint,
  call_count integer, call_seconds bigint, call_recorded_micros bigint, call_unpriced_seconds bigint,
  tpl_marketing integer, tpl_utility integer, tpl_authentication integer, tpl_unknown integer,
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
    (SELECT count(*)::int FROM messages m JOIN channels ch ON ch.id = m.channel_id AND ch.type = 'whatsapp' WHERE m.tenant_id = t.id AND m.direction = 'in' AND m.created_at >= p_from AND m.created_at < p_to),
    (SELECT count(*)::int FROM messages m JOIN channels ch ON ch.id = m.channel_id AND ch.type = 'whatsapp' WHERE m.tenant_id = t.id AND m.direction = 'out' AND m.status IN ('sent','delivered','read') AND m.created_at >= p_from AND m.created_at < p_to)
  FROM tenants t
  LEFT JOIN LATERAL (
    -- Plantillas enviadas (las unicas que cobra Meta): se clasifican por la categoria de la plantilla usada.
    SELECT
      count(*) FILTER (WHERE x.category = 'marketing')::int AS marketing,
      count(*) FILTER (WHERE x.category = 'utility')::int AS utility,
      count(*) FILTER (WHERE x.category = 'authentication')::int AS authentication,
      count(*) FILTER (WHERE x.category IS NULL)::int AS unknown
    FROM (
      SELECT (SELECT tpl.category::text FROM templates tpl WHERE tpl.tenant_id = m.tenant_id AND tpl.name = substring(m.body from '"name":"([^"]+)"') LIMIT 1) AS category
      FROM messages m
      JOIN channels ch ON ch.id = m.channel_id AND ch.type = 'whatsapp'
      WHERE m.tenant_id = t.id AND m.type = 'template' AND m.direction = 'out'
        AND m.status IN ('sent','delivered','read') AND m.created_at >= p_from AND m.created_at < p_to
    ) x
  ) tp ON true
  ORDER BY t.created_at DESC;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION operator_costs(timestamptz, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operator_costs(timestamptz, timestamptz) TO empleado_app;
