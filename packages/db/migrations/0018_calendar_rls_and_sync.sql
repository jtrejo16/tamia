-- Aislamiento por negocio para la conexion con el calendario externo (Google).
ALTER TABLE calendar_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE calendar_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON calendar_connections
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

-- Citas que toca reflejar en el calendario: de negocios activos CON calendario conectado y en buen estado.
--   * confirmadas (y que no terminaron hace mas de un dia) -> crear o actualizar el evento;
--   * canceladas que ya tienen evento -> borrarlo.
-- Esta cruza negocios (SECURITY DEFINER); solo devuelve ids y el worker trabaja cada negocio bajo su aislamiento.
-- Una cita esta "pendiente de sincronizar" si nunca se sincronizo o cambio despues de la ultima vez.
CREATE FUNCTION calendar_due_appointments(p_limit integer)
RETURNS TABLE (tenant_id uuid, appointment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.tenant_id, a.id
  FROM appointments a
  JOIN calendar_connections c ON c.tenant_id = a.tenant_id AND c.status = 'active'
  JOIN tenants t ON t.id = a.tenant_id AND t.status = 'active'
  -- date_trunc: el worker guarda la marca con precision de milisegundos (JavaScript) y updated_at puede traer
  -- microsegundos; sin esto una cita ya sincronizada se vería "pendiente" para siempre.
  WHERE (a.calendar_synced_at IS NULL OR a.calendar_synced_at < date_trunc('milliseconds', a.updated_at))
    AND (
      (a.status = 'confirmed' AND a.ends_at > now() - interval '1 day')
      OR (a.status = 'cancelled' AND a.calendar_event_id IS NOT NULL)
    )
  ORDER BY a.updated_at
  LIMIT p_limit
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION calendar_due_appointments(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION calendar_due_appointments(integer) TO empleado_app;
