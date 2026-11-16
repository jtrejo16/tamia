-- Aislamiento por negocio para el asistente telefonico.
ALTER TABLE voice_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE voice_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON voice_settings
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE calls FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON calls
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint

-- Los avisos de Retell llegan ANTES de saber el negocio: se resuelve por el id del agente que
-- creamos para el (SECURITY DEFINER). Solo devuelve negocios con voz activada y aprobados.
CREATE FUNCTION resolve_voice_agent(p_agent_id text)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.tenant_id
  FROM voice_settings v
  JOIN tenants t ON t.id = v.tenant_id
  WHERE v.retell_agent_id = p_agent_id AND v.enabled = true AND t.status = 'active'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_voice_agent(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_voice_agent(text) TO empleado_app;
