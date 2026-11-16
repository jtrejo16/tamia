-- Aislamiento por negocio para las identidades de clientes en Messenger/Instagram.
ALTER TABLE contact_identities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE contact_identities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON contact_identities
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
