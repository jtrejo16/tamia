import { describe, expect, it, vi } from "vitest";
import {
  GraphAdminClient,
  REMINDER_TEMPLATES,
  WhatsAppApiError,
  WhatsAppClient,
  buttonPayloads,
  decodeTemplateMessage,
  encodeTemplateMessage,
  normalizeTemplateStatus,
  parseReminderPayload,
  reminderParamList,
  renderTemplateBody,
  toMetaTemplate,
} from "../src";

const APPT = "3f2b9c1e-4d5a-4b7c-8e9f-0a1b2c3d4e5f";
const params = reminderParamList({
  customerName: "Ana",
  service: "limpieza dental",
  when: "martes 2 de marzo a las 10:00",
  business: "Clínica Sonrisa",
});

describe("plantillas de recordatorio", () => {
  it("renderiza el texto tal como lo vera el cliente", () => {
    expect(renderTemplateBody(REMINDER_TEMPLATES["24h"].body, params)).toBe(
      "Hola Ana, te recordamos tu cita de limpieza dental el martes 2 de marzo a las 10:00 en Clínica Sonrisa. ¿Nos confirmas tu asistencia?",
    );
    expect(renderTemplateBody(REMINDER_TEMPLATES["2h"].body, params)).toContain("es hoy, martes 2 de marzo a las 10:00, en Clínica Sonrisa");
  });

  it("cumplen lo que Meta exige: variables numeradas sin saltos, sin variables al inicio ni al final, con ejemplos", () => {
    for (const t of Object.values(REMINDER_TEMPLATES)) {
      const vars = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      expect(vars).toEqual([1, 2, 3, 4]);
      expect(t.examples).toHaveLength(vars.length);
      expect(t.body.startsWith("{{")).toBe(false);
      expect(t.body.endsWith("}}")).toBe(false);
      expect(t.body.length).toBeLessThan(1024);
      expect(t.category).toBe("UTILITY");
      expect(t.quickReplies).toEqual(["Confirmo", "Reagendar"]);
      expect(t.name).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("arma el cuerpo que se manda a Meta al crear la plantilla", () => {
    expect(toMetaTemplate(REMINDER_TEMPLATES["24h"])).toEqual({
      name: "recordatorio_cita_24h",
      language: "es_MX",
      category: "UTILITY",
      components: [
        { type: "BODY", text: REMINDER_TEMPLATES["24h"].body, example: { body_text: [REMINDER_TEMPLATES["24h"].examples] } },
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Confirmo" }, { type: "QUICK_REPLY", text: "Reagendar" }] },
      ],
    });
  });

  it("los botones llevan la cita y la respuesta se puede interpretar", () => {
    const [confirm, resched] = buttonPayloads(APPT);
    expect(parseReminderPayload(confirm)).toEqual({ action: "confirm", appointmentId: APPT });
    expect(parseReminderPayload(resched)).toEqual({ action: "resched", appointmentId: APPT });
    for (const bad of [undefined, "", "rem:otra:" + APPT, "rem:confirm:no-es-uuid", "confirm:" + APPT, `rem:confirm:${APPT}x`]) {
      expect(parseReminderPayload(bad)).toBeNull();
    }
  });

  it("el mensaje guardado conserva la plantilla y el texto renderizado, y tolera basura", () => {
    const raw = encodeTemplateMessage(REMINDER_TEMPLATES["24h"], params, buttonPayloads(APPT));
    const decoded = decodeTemplateMessage(raw);
    expect(decoded).toMatchObject({ kind: "template", name: "recordatorio_cita_24h", language: "es_MX", buttons: buttonPayloads(APPT) });
    expect(decoded!.text).toContain("Hola Ana");
    for (const junk of [null, undefined, "", "hola", "{}", '{"kind":"otra"}', "[1,2]"]) expect(decodeTemplateMessage(junk)).toBeNull();
  });
});

describe("envio de plantillas", () => {
  const ok = () => new Response(JSON.stringify({ messages: [{ id: "wamid.TPL" }] }));
  it("manda cuerpo y botones de respuesta rapida con sus identificadores", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    const client = new WhatsAppClient({ accessToken: "T", phoneNumberId: "PN", fetch: fetchMock });
    const res = await client.sendTemplate("5219841112222", {
      name: "recordatorio_cita_24h",
      language: "es_MX",
      bodyParams: params,
      buttonPayloads: buttonPayloads(APPT),
    });
    expect(res.wamid).toBe("wamid.TPL");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toMatchObject({ messaging_product: "whatsapp", to: "5219841112222", type: "template" });
    expect(body.template.name).toBe("recordatorio_cita_24h");
    expect(body.template.language).toEqual({ code: "es_MX" });
    expect(body.template.components[0]).toEqual({ type: "body", parameters: params.map((text) => ({ type: "text", text })) });
    expect(body.template.components.slice(1)).toEqual([
      { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `rem:confirm:${APPT}` }] },
      { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `rem:resched:${APPT}` }] },
    ]);
  });
});

describe("administracion de plantillas en Meta", () => {
  const admin = (fetchImpl: typeof fetch) => new GraphAdminClient({ accessToken: "TOKEN-SECRETO", fetch: fetchImpl });

  it("traduce los estados de Meta a los nuestros", () => {
    expect(normalizeTemplateStatus("APPROVED")).toBe("approved");
    expect(normalizeTemplateStatus("rejected")).toBe("rejected");
    expect(normalizeTemplateStatus("PAUSED")).toBe("paused");
    expect(normalizeTemplateStatus("DISABLED")).toBe("disabled");
    for (const pending of ["PENDING", "IN_APPEAL", undefined, "ALGO_NUEVO"]) expect(normalizeTemplateStatus(pending)).toBe("pending");
  });

  it("crea una plantilla en la cuenta correcta y devuelve su id y estado", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "999", status: "PENDING", category: "UTILITY" })));
    const res = await admin(fetchMock).createTemplate("WABA1", REMINDER_TEMPLATES["2h"]);
    expect(res).toEqual({ id: "999", status: "pending" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://graph.facebook.com/v23.0/WABA1/message_templates");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer TOKEN-SECRETO");
    expect(JSON.parse(init.body).name).toBe("recordatorio_cita_2h");
  });

  it("lista plantillas con su estado y motivo de rechazo, y sigue las paginas", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { id: "1", name: "recordatorio_cita_24h", language: "es_MX", status: "APPROVED", category: "UTILITY", rejected_reason: "NONE" },
              { id: "2", name: "otra", language: "es_MX", status: "REJECTED", category: "MARKETING", rejected_reason: "INVALID_FORMAT" },
            ],
            paging: { next: "https://graph.facebook.com/v23.0/WABA1/message_templates?after=XYZ" },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "3", name: "tercera", language: "en_US", status: "PENDING" }] })));
    const list = await admin(fetchMock).listTemplates("WABA1");
    expect(list.map((t) => [t.name, t.status])).toEqual([
      ["recordatorio_cita_24h", "approved"],
      ["otra", "rejected"],
      ["tercera", "pending"],
    ]);
    expect(list[0]!.rejectedReason).toBeUndefined();
    expect(list[1]!.rejectedReason).toBe("INVALID_FORMAT");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://graph.facebook.com/v23.0/WABA1/message_templates?after=XYZ");
  });

  it("los errores de Meta traen categoria y el mensaje no filtra el token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Invalid OAuth", code: 190 } }), { status: 401 }));
    const e = (await admin(fetchMock).listTemplates("W").catch((x) => x)) as WhatsAppApiError;
    expect(e).toBeInstanceOf(WhatsAppApiError);
    expect(e.kind).toBe("auth");
    expect(e.message).not.toContain("TOKEN-SECRETO");

    const net = (await admin(vi.fn().mockRejectedValue(new TypeError("fetch failed"))).createTemplate("W", REMINDER_TEMPLATES["24h"]).catch((x) => x)) as WhatsAppApiError;
    expect(net.kind).toBe("server");
  });
});
