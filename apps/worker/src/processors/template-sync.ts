import { channelsForTemplateSync, type Database } from "@empleado/db";
import { syncTemplates, type TemplateGraphDeps } from "@empleado/inbox";
import type { Logger } from "../config";

/**
 * Mantiene al dia el estado (pendiente / aprobada / rechazada) de las plantillas de cada
 * canal preguntando a Meta. Lo llama el worker cada pocos minutos y al arrancar.
 */
export function createTemplateSync(deps: { db: Database; graph: TemplateGraphDeps; log?: Logger }) {
  return async (): Promise<{ channels: number; changed: number; failed: number }> => {
    const targets = await channelsForTemplateSync(deps.db);
    let changed = 0;
    let failed = 0;
    for (const t of targets) {
      const result = await syncTemplates(deps.db, deps.graph, t.tenantId, t.channelId);
      if (result.ok) changed += result.synced;
      else {
        failed++;
        deps.log?.("templates.sync_failed", { tenantId: t.tenantId, error: result.error, details: "details" in result ? result.details : undefined });
      }
    }
    if (changed > 0) deps.log?.("templates.synced", { channels: targets.length, changed });
    return { channels: targets.length, changed, failed };
  };
}
