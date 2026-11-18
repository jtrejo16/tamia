-- Contexto de una escalacion para quien la toma: resumen del interes del cliente y si fue decision del asistente o falla tecnica.
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS summary text;
--> statement-breakpoint
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'assistant';
