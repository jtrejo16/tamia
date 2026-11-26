-- Horarios que cruzan la medianoche (por ejemplo, una taqueria de 18:00 a 02:00): cerrar a una hora menor que la de abrir significa
-- cerrar al dia siguiente. Antes la base exigia closes > opens; ahora solo exige que no sean iguales. La aplicacion decide quien puede
-- usarlos (solo negocios sin agenda de citas): ver setHours en packages/inbox/src/config.ts.
ALTER TABLE business_hours DROP CONSTRAINT business_hours_order;
--> statement-breakpoint
ALTER TABLE business_hours ADD CONSTRAINT business_hours_order CHECK (closes <> opens);
