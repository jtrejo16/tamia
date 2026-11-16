-- Aislamiento multi-tenant (Row Level Security), rol de aplicacion y restricciones que
-- Drizzle no puede expresar. IMPORTANTE: el rol propietario que corre las migraciones debe
-- tener BYPASSRLS o ser superusuario (las funciones SECURITY DEFINER dependen de ello).
-- Cada sentencia va separada por un breakpoint porque el migrador ejecuta una por una.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'empleado_app') THEN
    CREATE ROLE empleado_app NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint

-- Contexto de la peticion: lo fija la capa de datos con set_config(..., true) en cada transaccion.
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
--> statement-breakpoint

-- Toda tabla con columna tenant_id recibe RLS forzado + una politica de aislamiento.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())',
      t
    );
  END LOOP;
END $$;
--> statement-breakpoint

-- tenants: su propio id es el tenant.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenants
  USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());
--> statement-breakpoint

-- memberships: ademas de su tenant, un usuario ve sus propias membresias (para elegir negocio).
CREATE POLICY membership_self ON memberships FOR SELECT USING (user_id = app_user_id());
--> statement-breakpoint

-- users: solo uno mismo o companeros del tenant actual.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY users_visible ON users FOR SELECT USING (
  id = app_user_id()
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id)
);
--> statement-breakpoint
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY users_update_self ON users FOR UPDATE
  USING (id = app_user_id()) WITH CHECK (id = app_user_id());
--> statement-breakpoint

-- Resolver webhook -> tenant ANTES de conocer el tenant (por eso SECURITY DEFINER).
CREATE OR REPLACE FUNCTION resolve_channel(p_type text, p_external_id text)
RETURNS TABLE (tenant_id uuid, channel_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.tenant_id, c.id
  FROM channels c
  WHERE c.type = p_type AND c.external_id = p_external_id AND c.status = 'active'
$$;
--> statement-breakpoint

-- Buscar usuario por correo al iniciar sesion, antes de conocer su id.
CREATE OR REPLACE FUNCTION auth_find_user(p_email text)
RETURNS TABLE (id uuid, email text, password_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.email, u.password_hash FROM users u WHERE lower(u.email) = lower(p_email)
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION resolve_channel(text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_find_user(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_channel(text, text) TO empleado_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_find_user(text) TO empleado_app;
--> statement-breakpoint

-- Permisos del rol de aplicacion.
GRANT USAGE ON SCHEMA public TO empleado_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO empleado_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO empleado_app;
--> statement-breakpoint
-- La bitacora es append-only y un negocio no se borra desde la app.
REVOKE UPDATE, DELETE ON audit_log FROM empleado_app;
--> statement-breakpoint
REVOKE DELETE ON tenants FROM empleado_app;
--> statement-breakpoint

-- Citas: nunca dos citas activas del mismo empleado en el mismo intervalo.
ALTER TABLE appointments ADD CONSTRAINT appointments_time_order CHECK (ends_at > starts_at);
--> statement-breakpoint
ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap EXCLUDE USING gist (
  staff_id WITH =,
  tstzrange(starts_at, ends_at) WITH &&
) WHERE (status IN ('pending', 'confirmed'));
--> statement-breakpoint

ALTER TABLE business_hours ADD CONSTRAINT business_hours_weekday CHECK (weekday BETWEEN 0 AND 6);
--> statement-breakpoint
ALTER TABLE business_hours ADD CONSTRAINT business_hours_order CHECK (closes > opens);
--> statement-breakpoint
ALTER TABLE services ADD CONSTRAINT services_duration_positive CHECK (duration_min > 0);
