-- Correccion de billing_apply_preapproval: el estado debe convertirse explicitamente a subscription_status.
CREATE OR REPLACE FUNCTION billing_apply_preapproval(p_preapproval text, p_mp_status text, p_next_payment timestamptz)
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
      status = (CASE WHEN trial_ends_at IS NOT NULL AND trial_ends_at > now() THEN 'trialing' ELSE 'active' END)::subscription_status,
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
