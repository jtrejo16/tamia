-- Suscripciones, alta de negocios y operador de la plataforma.
-- La tabla subscriptions la LEE el negocio (RLS) pero solo se modifica con las funciones de abajo.

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON subscriptions
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON subscriptions FROM empleado_app;
--> statement-breakpoint

-- Los negocios que ya existen (demo) quedan de cortesia: no se les cobra ni se les corta el servicio.
INSERT INTO subscriptions (tenant_id, status) SELECT id, 'comped' FROM tenants;
--> statement-breakpoint

-- Es operador de la plataforma el usuario de la sesion actual?
CREATE FUNCTION app_is_operator() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((SELECT u.is_operator FROM users u WHERE u.id = app_user_id()), false)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_is_operator() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_is_operator() TO empleado_app;
--> statement-breakpoint

-- ---------------------------------------------------------------- alta (registro publico)
-- Crea negocio (pendiente de aprobacion), dueno, configuracion del asistente y prueba gratis, todo
-- en una transaccion. Si el correo ya tiene cuenta NO se toca (no se puede secuestrar una cuenta
-- registrandose con su correo). code: ok | email_taken | slug_taken
CREATE FUNCTION signup_create_tenant(
  p_name text, p_slug text, p_vertical text, p_timezone text,
  p_email text, p_user_name text, p_hash text,
  p_model text, p_fallback text, p_trial_days integer
)
RETURNS TABLE (tenant_id uuid, user_id uuid, code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t uuid;
  u uuid;
BEGIN
  IF p_hash IS NULL OR length(p_hash) < 20 THEN
    RAISE EXCEPTION 'hash invalido';
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(p_email)) THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'email_taken'::text;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM tenants WHERE slug = p_slug) THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'slug_taken'::text;
    RETURN;
  END IF;

  INSERT INTO tenants (name, slug, vertical, timezone, plan, status)
  VALUES (p_name, p_slug, p_vertical, p_timezone, 'esencial', 'pending')
  RETURNING id INTO t;

  INSERT INTO users (email, name, password_hash) VALUES (lower(p_email), p_user_name, p_hash)
  RETURNING id INTO u;

  INSERT INTO memberships (tenant_id, user_id, role) VALUES (t, u, 'owner');
  INSERT INTO agent_configs (tenant_id, model, fallback_model, autonomy, pack_slug, pack_version)
  VALUES (t, p_model, p_fallback, 'copilot', p_vertical, '0.1.0');
  INSERT INTO subscriptions (tenant_id, status, trial_ends_at)
  VALUES (t, 'trialing', now() + make_interval(days => p_trial_days));
  INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id)
  VALUES (t, u, 'signup', 'tenant', t::text);

  RETURN QUERY SELECT t, u, 'ok'::text;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION signup_create_tenant(text, text, text, text, text, text, text, text, text, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION signup_create_tenant(text, text, text, text, text, text, text, text, text, integer) TO empleado_app;
--> statement-breakpoint

-- ---------------------------------------------------------------- cobro (Mercado Pago)
-- El dueno inicia un checkout: se guarda que suscripcion de MP esta en curso y que plan eligio.
-- El plan NO cambia hasta que Mercado Pago confirme (webhook).
CREATE FUNCTION billing_attach_preapproval(p_preapproval text, p_plan plan, p_payer_email text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t uuid := app_tenant_id();
BEGIN
  IF t IS NULL OR p_preapproval IS NULL OR length(p_preapproval) < 3 THEN
    RETURN false;
  END IF;
  UPDATE subscriptions
     SET mp_preapproval_id = p_preapproval, pending_plan = p_plan, mp_payer_email = p_payer_email, updated_at = now()
   WHERE tenant_id = t;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION billing_attach_preapproval(text, plan, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing_attach_preapproval(text, plan, text) TO empleado_app;
--> statement-breakpoint

-- Aplica el estado que Mercado Pago reporta para una suscripcion (la busca por SU id guardado, no
-- por lo que diga el mensaje). Devuelve el negocio afectado o NULL si no la conocemos.
CREATE FUNCTION billing_apply_preapproval(p_preapproval text, p_mp_status text, p_next_payment timestamptz)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s subscriptions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM subscriptions WHERE mp_preapproval_id = p_preapproval;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  -- Un negocio de cortesia no cambia por cobros.
  IF s.status = 'comped' THEN
    RETURN s.tenant_id;
  END IF;

  IF p_mp_status = 'authorized' THEN
    UPDATE subscriptions SET
      card_authorized = true,
      status = CASE WHEN trial_ends_at IS NOT NULL AND trial_ends_at > now() THEN 'trialing' ELSE 'active' END,
      current_period_end = coalesce(p_next_payment, current_period_end),
      updated_at = now()
    WHERE id = s.id;
    IF s.pending_plan IS NOT NULL THEN
      UPDATE tenants SET plan = s.pending_plan, updated_at = now() WHERE id = s.tenant_id;
      UPDATE subscriptions SET pending_plan = NULL WHERE id = s.id;
    END IF;
  ELSIF p_mp_status = 'paused' THEN
    UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE id = s.id;
  ELSIF p_mp_status = 'cancelled' THEN
    UPDATE subscriptions SET status = 'canceled', card_authorized = false, updated_at = now() WHERE id = s.id;
  END IF;
  RETURN s.tenant_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION billing_apply_preapproval(text, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing_apply_preapproval(text, text, timestamptz) TO empleado_app;
--> statement-breakpoint

-- ---------------------------------------------------------------- operador
CREATE FUNCTION operator_list_tenants()
RETURNS TABLE (
  id uuid, name text, slug text, vertical text, status text, plan text, created_at timestamptz,
  sub_status text, trial_ends_at timestamptz, card_authorized boolean,
  owner_email text, channel_connected boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT app_is_operator() THEN
    RAISE EXCEPTION 'no autorizado';
  END IF;
  RETURN QUERY
  SELECT t.id, t.name, t.slug, t.vertical, t.status::text, t.plan::text, t.created_at,
         s.status::text, s.trial_ends_at, coalesce(s.card_authorized, false),
         (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.tenant_id = t.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1),
         EXISTS (SELECT 1 FROM channels c WHERE c.tenant_id = t.id AND c.credentials_enc IS NOT NULL)
  FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id
  ORDER BY t.created_at DESC;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION operator_list_tenants() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operator_list_tenants() TO empleado_app;
--> statement-breakpoint

CREATE FUNCTION operator_set_tenant_status(p_tenant uuid, p_status text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT app_is_operator() THEN
    RAISE EXCEPTION 'no autorizado';
  END IF;
  IF p_status NOT IN ('active', 'paused', 'cancelled') THEN
    RAISE EXCEPTION 'estado invalido';
  END IF;
  UPDATE tenants SET status = p_status::tenant_status, updated_at = now() WHERE id = p_tenant;
  IF FOUND THEN
    INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, diff)
    VALUES (p_tenant, app_user_id(), 'operator.set_status', 'tenant', p_tenant::text, jsonb_build_object('status', p_status));
  END IF;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION operator_set_tenant_status(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operator_set_tenant_status(uuid, text) TO empleado_app;
--> statement-breakpoint

-- Cortesia: el negocio usa el servicio sin cobro (pilotos, socios) o se le quita.
CREATE FUNCTION operator_set_comped(p_tenant uuid, p_on boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT app_is_operator() THEN
    RAISE EXCEPTION 'no autorizado';
  END IF;
  UPDATE subscriptions
     SET status = CASE WHEN p_on THEN 'comped'::subscription_status
                       WHEN card_authorized THEN 'active'::subscription_status
                       ELSE 'trialing'::subscription_status END,
         updated_at = now()
   WHERE tenant_id = p_tenant;
  IF FOUND THEN
    INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, diff)
    VALUES (p_tenant, app_user_id(), 'operator.set_comped', 'subscription', p_tenant::text, jsonb_build_object('comped', p_on));
  END IF;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION operator_set_comped(uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operator_set_comped(uuid, boolean) TO empleado_app;
