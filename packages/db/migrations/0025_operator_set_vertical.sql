-- Operador: cambia el giro de un negocio. El giro vive en DOS sitios (tenants.vertical y agent_configs.pack_slug, que se
-- crea igual al giro al registrarse) y hay que moverlos juntos. Devuelve el giro anterior, o NULL si el negocio no existe.
-- La lista de giros permitidos la valida la aplicacion (cambia con cada giro nuevo); aqui solo se exige que parezca un id.
CREATE FUNCTION operator_set_vertical(p_tenant uuid, p_vertical text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  previous text;
BEGIN
  IF NOT app_is_operator() THEN
    RAISE EXCEPTION 'no autorizado';
  END IF;
  IF p_vertical IS NULL OR p_vertical !~ '^[a-z0-9_-]{1,40}$' THEN
    RAISE EXCEPTION 'giro invalido';
  END IF;
  SELECT vertical INTO previous FROM tenants WHERE id = p_tenant;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF previous = p_vertical THEN
    RETURN previous; -- ya tenia ese giro: no se toca nada ni se deja registro
  END IF;
  UPDATE tenants SET vertical = p_vertical, updated_at = now() WHERE id = p_tenant;
  UPDATE agent_configs SET pack_slug = p_vertical, pack_version = '0.1.0', updated_at = now() WHERE tenant_id = p_tenant;
  INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, diff)
  VALUES (p_tenant, app_user_id(), 'operator.set_vertical', 'tenant', p_tenant::text, jsonb_build_object('from', previous, 'to', p_vertical));
  RETURN previous;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION operator_set_vertical(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operator_set_vertical(uuid, text) TO empleado_app;
