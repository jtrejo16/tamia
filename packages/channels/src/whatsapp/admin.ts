import { WhatsAppApiError, classifyGraphError } from "./client";
import { toMetaTemplate, type TemplateDefinition } from "./templates";

/** Estados de una plantilla en Meta, normalizados a los que usa nuestra base de datos. */
export type TemplateStatus = "pending" | "approved" | "rejected" | "paused" | "disabled";

export function normalizeTemplateStatus(raw: string | undefined): TemplateStatus {
  switch ((raw ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "REJECTED":
      return "rejected";
    case "PAUSED":
      return "paused";
    case "DISABLED":
    case "DELETED":
      return "disabled";
    default:
      return "pending"; // PENDING, IN_APPEAL, PENDING_DELETION...
  }
}

export interface RemoteTemplate {
  id: string;
  name: string;
  language: string;
  status: TemplateStatus;
  category: string;
  rejectedReason?: string;
}

export interface GraphAdminOptions {
  accessToken: string;
  apiVersion?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Operaciones de administracion de la cuenta de WhatsApp (plantillas). Distinto del envio. */
export class GraphAdminClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: GraphAdminOptions) {
    if (!options.accessToken) throw new Error("Falta el token de acceso de WhatsApp");
    this.base = `${(options.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "")}/${options.apiVersion ?? "v23.0"}`;
    this.doFetch = options.fetch ?? fetch;
  }

  /** Crea una plantilla (queda "pending" hasta que Meta la revise). */
  async createTemplate(wabaId: string, def: TemplateDefinition): Promise<{ id: string; status: TemplateStatus }> {
    const json = (await this.call(`${encodeURIComponent(wabaId)}/message_templates`, {
      method: "POST",
      body: toMetaTemplate(def),
    })) as { id?: string; status?: string };
    if (!json.id) throw new WhatsAppApiError("Meta no devolvio el id de la plantilla", { kind: "other" });
    return { id: json.id, status: normalizeTemplateStatus(json.status) };
  }

  async listTemplates(wabaId: string): Promise<RemoteTemplate[]> {
    const out: RemoteTemplate[] = [];
    let url: string | null =
      `${encodeURIComponent(wabaId)}/message_templates?fields=id,name,language,status,category,rejected_reason&limit=100`;
    for (let page = 0; url && page < 10; page++) {
      const json = (await this.call(url, { method: "GET" })) as {
        data?: Array<{ id: string; name: string; language: string; status?: string; category?: string; rejected_reason?: string }>;
        paging?: { next?: string };
      };
      for (const t of json.data ?? []) {
        out.push({
          id: t.id,
          name: t.name,
          language: t.language,
          status: normalizeTemplateStatus(t.status),
          category: t.category ?? "",
          rejectedReason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : undefined,
        });
      }
      const next: string | undefined = json.paging?.next;
      // "next" es una URL completa de Meta; se conserva solo la parte relativa a la version.
      url = next ? next.slice(next.indexOf(`/${this.options.apiVersion ?? "v23.0"}/`) + `/${this.options.apiVersion ?? "v23.0"}/`.length) : null;
    }
    return out;
  }

  private async call(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<unknown> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.base}/${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${this.options.accessToken}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new WhatsAppApiError(`Fallo de red con WhatsApp (${e instanceof Error ? e.name : "error"})`, { kind: "server" });
    }
    const raw = await response.text();
    let json: { error?: { message?: string; code?: number; error_subcode?: number; error_user_msg?: string } } = {};
    try {
      json = JSON.parse(raw);
    } catch {
      /* no JSON */
    }
    if (!response.ok || json.error) {
      const code = json.error?.code;
      throw new WhatsAppApiError(
        `WhatsApp rechazo la operacion (HTTP ${response.status}${code ? `, codigo ${code}` : ""}): ${json.error?.error_user_msg ?? json.error?.message ?? "sin detalle"}`,
        { status: response.status, code, subcode: json.error?.error_subcode, kind: classifyGraphError(response.status, code) },
      );
    }
    return json;
  }
}
