-- Recuperacion de envios: si el proceso se cae entre guardar un mensaje saliente y encolarlo,
-- un barrido periodico lo encuentra. Es multi-tenant por naturaleza (mira TODOS los negocios),
-- por eso es SECURITY DEFINER y solo devuelve ids, no contenido.
CREATE OR REPLACE FUNCTION stale_queued_messages(p_older_than_seconds integer, p_limit integer DEFAULT 200)
RETURNS TABLE (tenant_id uuid, message_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.tenant_id, m.id
  FROM messages m
  WHERE m.direction = 'out'
    AND m.status = 'queued'
    AND m.created_at < now() - make_interval(secs => p_older_than_seconds)
  ORDER BY m.created_at
  LIMIT p_limit
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION stale_queued_messages(integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION stale_queued_messages(integer, integer) TO empleado_app;
