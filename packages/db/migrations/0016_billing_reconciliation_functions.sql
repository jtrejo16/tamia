-- Conciliacion periodica de suscripciones con Mercado Pago (por si se pierde un aviso del webhook).
-- Funciones SECURITY DEFINER: la tabla subscriptions es de solo lectura para la app y esto cruza negocios.

-- Suscripciones que conviene revisar ahora: las que tienen suscripcion en Mercado Pago y pueden cambiar
-- (en prueba, activas, con pago pendiente) y los checkouts RECIENTES aun sin confirmar. Las canceladas por
-- nosotros y las de cortesia no cambian por cobros. Se rota: cada una se revisa como maximo cada p_every.
CREATE FUNCTION billing_due_reconciliation(p_limit integer, p_every interval)
RETURNS TABLE (preapproval_id text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.mp_preapproval_id, s.status::text
  FROM subscriptions s
  WHERE s.mp_preapproval_id IS NOT NULL
    AND s.status <> 'comped'
    AND s.status <> 'canceled'
    AND (s.card_authorized OR s.updated_at > now() - interval '3 days')
    AND (s.reconciled_at IS NULL OR s.reconciled_at < now() - p_every)
  ORDER BY coalesce(s.reconciled_at, 'epoch'::timestamptz)
  LIMIT p_limit
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION billing_due_reconciliation(integer, interval) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing_due_reconciliation(integer, interval) TO empleado_app;
--> statement-breakpoint

-- Marca una suscripcion como revisada (solo si ya se aplico lo que dijo Mercado Pago).
CREATE FUNCTION billing_mark_reconciled(p_preapproval text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE subscriptions SET reconciled_at = now() WHERE mp_preapproval_id = p_preapproval;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION billing_mark_reconciled(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing_mark_reconciled(text) TO empleado_app;
--> statement-breakpoint

-- Estado actual (para saber si la conciliacion cambio algo).
CREATE FUNCTION billing_status_of(p_preapproval text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.status::text FROM subscriptions s WHERE s.mp_preapproval_id = p_preapproval
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION billing_status_of(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing_status_of(text) TO empleado_app;
