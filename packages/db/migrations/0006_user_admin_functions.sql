-- auth_find_user ahora tambien devuelve la version de sesiones y si debe cambiar la contrasena.
-- (Cambia el tipo de retorno, por eso se borra y se vuelve a crear.)
DROP FUNCTION IF EXISTS auth_find_user(text);
--> statement-breakpoint
CREATE FUNCTION auth_find_user(p_email text)
RETURNS TABLE (id uuid, email text, password_hash text, session_version integer, must_change_password boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.email, u.password_hash, u.session_version, u.must_change_password
  FROM users u WHERE lower(u.email) = lower(p_email)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_find_user(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_find_user(text) TO empleado_app;
--> statement-breakpoint

-- Un dueno restablece la contrasena de alguien de SU negocio (la deja temporal y cierra sus sesiones).
-- La politica de users solo deja a cada quien modificarse a si mismo, por eso esta funcion.
-- Regla de seguridad: solo si ese usuario pertenece UNICAMENTE a este negocio; si tambien esta
-- en otro, el dueno de este no puede tocar su cuenta (seria tomar el control de su acceso al otro).
CREATE FUNCTION admin_set_member_password(p_user uuid, p_hash text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t uuid := app_tenant_id();
BEGIN
  IF t IS NULL OR p_hash IS NULL OR length(p_hash) < 20 THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = p_user AND m.tenant_id = t) THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = p_user AND m.tenant_id <> t) THEN
    RETURN false;
  END IF;
  UPDATE users
     SET password_hash = p_hash,
         must_change_password = true,
         session_version = session_version + 1,
         updated_at = now()
   WHERE id = p_user;
  RETURN true;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_set_member_password(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_set_member_password(uuid, text) TO empleado_app;
