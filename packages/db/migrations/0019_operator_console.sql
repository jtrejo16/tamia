-- Consola del operador: resumen de TODOS los negocios (cobro, canales, actividad y problemas) y extender prueba.
-- Funciones SECURITY DEFINER que solo responden al operador (users.is_operator); nunca devuelven claves.

-- Las consultas por negocio sobre mensajes (ultimo mensaje, actividad reciente, estadisticas) necesitan este indice.
CREATE INDEX IF NOT EXISTS messages_tenant_created_idx ON messages (tenant_id, created_at);
--> statement-breakpoint

CREATE FUNCTION operator_overview()
RETURNS TABLE (
  id uuid, name text, slug text, vertical text, status text, plan text, created_at timestamptz, timezone text,
  owner_email text, owner_name text, members integer,
  sub_status text, trial_ends_at timestamptz, current_period_end timestamptz, card_authorized boolean,
  has_checkout boolean, reconciled_at timestamptz, sub_updated_at timestamptz,
  channels jsonb,
  last_inbound_at timestamptz, last_outbound_at timestamptz,
  inbound_7d integer, bot_7d integer, failed_24h integer,
  open_handoffs integer, pending_approvals integer, appointments_next_7d integer,
  voice_enabled boolean, voice_synced boolean, calendar_status text,
  templates_rejected integer, templates_pending integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT app_is_operator() THEN
    RAISE EXCEPTION 'no autorizado';
  END IF;
  RETURN QUERY
  SELECT
    t.id, t.name, t.slug, t.vertical, t.status::text, t.plan::text, t.created_at, t.timezone,
    (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = t.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1),
    (SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = t.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1),
    (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id),
    s.status::text, s.trial_ends_at, s.current_period_end, coalesce(s.card_authorized, false),
    (s.mp_preapproval_id IS NOT NULL), s.reconciled_at, s.updated_at,
    coalesce((SELECT jsonb_agg(jsonb_build_object(
        'type', c.type, 'status', c.status::text, 'hasToken', c.credentials_enc IS NOT NULL,
        'quality', c.quality_rating, 'account', coalesce(c.display_phone, c.meta->>'name', c.external_id)
      ) ORDER BY c.type) FROM channels c WHERE c.tenant_id = t.id AND c.type in ('whatsapp','messenger','instagram')), '[]'::jsonb),
    (SELECT max(m.created_at) FROM messages m JOIN channels c ON c.id = m.channel_id AND c.type in ('whatsapp','messenger','instagram') WHERE m.tenant_id = t.id AND m.direction = 'in'),
    (SELECT max(m.created_at) FROM messages m JOIN channels c ON c.id = m.channel_id AND c.type in ('whatsapp','messenger','instagram') WHERE m.tenant_id = t.id AND m.direction = 'out'),
    (SELECT count(*)::int FROM messages m JOIN channels c ON c.id = m.channel_id AND c.type in ('whatsapp','messenger','instagram') WHERE m.tenant_id = t.id AND m.direction = 'in' AND m.created_at > now() - interval '7 days'),
    (SELECT count(*)::int FROM messages m JOIN channels c ON c.id = m.channel_id AND c.type in ('whatsapp','messenger','instagram') WHERE m.tenant_id = t.id AND m.direction = 'out' AND m.sender = 'bot' AND m.created_at > now() - interval '7 days'),
    (SELECT count(*)::int FROM messages m WHERE m.tenant_id = t.id AND m.direction = 'out' AND m.status = 'failed' AND m.created_at > now() - interval '24 hours'),
    (SELECT count(*)::int FROM handoffs h WHERE h.tenant_id = t.id AND h.resolved_at IS NULL),
    (SELECT count(*)::int FROM approvals a WHERE a.tenant_id = t.id AND a.status = 'pending'),
    (SELECT count(*)::int FROM appointments a WHERE a.tenant_id = t.id AND a.status IN ('pending','confirmed') AND a.starts_at >= now() AND a.starts_at < now() + interval '7 days'),
    coalesce((SELECT v.enabled FROM voice_settings v WHERE v.tenant_id = t.id), false),
    coalesce((SELECT v.retell_agent_id IS NOT NULL FROM voice_settings v WHERE v.tenant_id = t.id), false),
    (SELECT cc.status FROM calendar_connections cc WHERE cc.tenant_id = t.id),
    (SELECT count(*)::int FROM templates tp WHERE tp.tenant_id = t.id AND tp.status = 'rejected'),
    (SELECT count(*)::int FROM templates tp WHERE tp.tenant_id = t.id AND tp.status = 'pending')
  FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id
  ORDER BY t.created_at DESC;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION operator_overview() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operator_overview() TO empleado_app;
--> statement-breakpoint

-- Extiende la prueba gratis N dias (de hoy o del fin actual, lo que sea mayor). Solo negocios en prueba.
CREATE FUNCTION operator_extend_trial(p_tenant uuid, p_days integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT app_is_operator() THEN
    RAISE EXCEPTION 'no autorizado';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
    RAISE EXCEPTION 'dias invalidos';
  END IF;
  UPDATE subscriptions
     SET trial_ends_at = greatest(coalesce(trial_ends_at, now()), now()) + make_interval(days => p_days), updated_at = now()
   WHERE tenant_id = p_tenant AND status = 'trialing';
  IF FOUND THEN
    INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, diff)
    VALUES (p_tenant, app_user_id(), 'operator.extend_trial', 'subscription', p_tenant::text, jsonb_build_object('days', p_days));
  END IF;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION operator_extend_trial(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operator_extend_trial(uuid, integer) TO empleado_app;
