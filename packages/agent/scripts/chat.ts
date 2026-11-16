/**
 * Probador de chat en terminal: escribes como cliente y el agente responde con el mismo
 * runtime que usara WhatsApp (modelo real de OpenRouter, herramientas y base de datos).
 *
 *   pnpm --filter @empleado/agent chat [--slug sonrisa] [--phone +529990000001]
 *                                      [--autonomy auto|semi|copilot] [--nuevo]
 *
 * Comandos: /estado  /aprobar  /bot  /nuevo  /salir
 */
import { approvals, conversations, withTenant } from "@empleado/db";
import { eq } from "drizzle-orm";
import { createInterface } from "node:readline/promises";
import { applyApprovedActions, ensureConversation, loadTurnContext, runAgentTurn } from "../src";
import { findTenant, modeBanner, money, openDbs, provider, setAutonomy, showTools } from "./_shared";

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};

const slug = flag("slug", "sonrisa")!;
const autonomy = (flag("autonomy", "auto") as "auto" | "semi" | "copilot");
let phone = flag("phone", "+529990000001")!;
if (argv.includes("--nuevo")) phone = `+52999${Date.now().toString().slice(-7)}`;

const dbs = openDbs();
const llm = provider();
const tenant = await findTenant(dbs, slug);
await setAutonomy(dbs, tenant.id, autonomy);

let ref = await ensureConversation(dbs.app.db, { tenantId: tenant.id, phone });
let lastApprovalId: string | undefined;
let total = 0;

console.log(`\n${tenant.name} · cliente ${phone} · autonomía: ${autonomy}`);
console.log(modeBanner());
console.log("Escribe como si fueras el cliente. Comandos: /estado /aprobar /bot /nuevo /salir\n");

const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  while (true) {
    const line = (await rl.question("Tú: ")).trim();
    if (!line) continue;

    if (line === "/salir") break;
    if (line === "/nuevo") {
      phone = `+52999${Date.now().toString().slice(-7)}`;
      ref = await ensureConversation(dbs.app.db, { tenantId: tenant.id, phone });
      console.log(`(cliente nuevo ${phone})\n`);
      continue;
    }
    if (line === "/estado") {
      const [c] = await withTenant(dbs.app.db, { tenantId: tenant.id }, (tx) =>
        tx.select().from(conversations).where(eq(conversations.id, ref.conversationId)),
      );
      console.log(`(conversación: ${c?.state}; tarea: ${JSON.stringify(c?.taskState)})\n`);
      continue;
    }
    if (line === "/bot") {
      await withTenant(dbs.app.db, { tenantId: tenant.id }, (tx) =>
        tx.update(conversations).set({ state: "bot" }).where(eq(conversations.id, ref.conversationId)),
      );
      console.log("(el asistente vuelve a atender)\n");
      continue;
    }
    if (line === "/aprobar") {
      if (!lastApprovalId) {
        console.log("(no hay borrador pendiente)\n");
        continue;
      }
      const [approval] = await withTenant(dbs.app.db, { tenantId: tenant.id }, (tx) =>
        tx.select().from(approvals).where(eq(approvals.id, lastApprovalId!)),
      );
      const ctx = await loadTurnContext(dbs.app.db, tenant.id, ref.conversationId);
      const runs = await applyApprovedActions(ctx, approval?.proposedActions ?? []);
      await withTenant(dbs.app.db, { tenantId: tenant.id }, (tx) =>
        tx.update(approvals).set({ status: "approved", reviewedAt: new Date() }).where(eq(approvals.id, lastApprovalId!)),
      );
      console.log("(borrador aprobado; acciones ejecutadas)");
      showTools(runs as never);
      console.log(`Asistente (enviado): ${approval?.draft}\n`);
      lastApprovalId = undefined;
      continue;
    }

    const r = await runAgentTurn({
      db: dbs.app.db,
      llm,
      tenantId: tenant.id,
      conversationId: ref.conversationId,
      text: line,
    });
    total += r.usage.costUsd;

    showTools(r.toolTrace as never);
    if (r.action === "none") {
      console.log(`(el asistente no responde: ${r.reason === "human_has_control" ? "la conversación está con una persona; usa /bot" : r.reason})\n`);
    } else {
      const tag = r.action === "draft" ? " [BORRADOR, falta aprobar con /aprobar]" : "";
      console.log(`Asistente${tag}: ${r.text}`);
      if (r.attachments.length) console.log(`   📍 adjunto: ${r.attachments.map((a) => a.type).join(", ")}`);
      if (r.escalated) console.log("   ⚠ escalado a una persona");
      if (r.failure) console.log(`   ⚠ fallo: ${r.failure}`);
      lastApprovalId = r.approvalId ?? lastApprovalId;
      console.log(`   (${r.usage.models.join(", ")} · ${r.usage.calls} llamadas · ${money(r.usage.costUsd)} · sesión ${money(total)})\n`);
    }
  }
} finally {
  rl.close();
  await dbs.app.close();
  await dbs.owner.close();
}
