import { eq } from "drizzle-orm";
import { createDb } from "./client";
import { loadEnv, requireEnv } from "./env";
import * as s from "./schema";

loadEnv();

// Seed con el PROPIETARIO: crear negocios es una operacion administrativa, no de la app.
const { db, close } = createDb(requireEnv("DATABASE_URL"), { max: 1 });

const SLUG = "sonrisa";
const DEMO_EMAIL = "demo@sonrisa.test";

const FAQ = `Preguntas frecuentes - Clinica Dental Sonrisa

¿Aceptan seguros dentales? Trabajamos con reembolso: le damos factura y receta para que su aseguradora le reembolse. No tenemos convenio directo.
¿Cuánto dura una limpieza? Entre 40 y 45 minutos.
¿Duele el blanqueamiento? Puede causar sensibilidad leve unas horas; se usa gel desensibilizante.
¿Atienden niños? Sí, a partir de 4 años.
¿Qué hago si pierdo una resina? Agende lo antes posible; evite masticar de ese lado.
¿Formas de pago? Efectivo, tarjeta de débito/crédito y transferencia. Los tratamientos largos se pueden dividir en pagos.
¿Cuál es la política de cancelación? Avise con al menos 12 horas de anticipación; después de 15 minutos de retraso la cita se reprograma.`;

try {
  // Idempotente: borra el demo anterior (las FK en cascada limpian todo lo del tenant).
  await db.delete(s.tenants).where(eq(s.tenants.slug, SLUG));
  await db.delete(s.users).where(eq(s.users.email, DEMO_EMAIL));

  const [tenant] = await db
    .insert(s.tenants)
    .values({
      name: "Clínica Dental Sonrisa",
      slug: SLUG,
      vertical: "dental",
      timezone: "America/Merida",
      plan: "profesional",
      privacyNoticeUrl: "https://clinicasonrisa.example/aviso-de-privacidad",
      profile: {
        description: "clínica dental familiar en Mérida con más de 10 años de experiencia",
        address: "Calle 60 #500 por 35 y 37, Centro, Mérida, Yucatán",
        mapsUrl: "https://maps.google.com/?q=Calle+60+500+Centro+Merida",
        latitude: 20.9674,
        longitude: -89.6237,
        paymentMethods: ["efectivo", "tarjeta de débito o crédito", "transferencia"],
        keyFacts: [
          "Estacionamiento gratuito para pacientes en la calle 35.",
          "Atendemos niños a partir de 4 años.",
          "Aceptamos reembolso de seguros dentales (damos factura y receta), sin convenio directo.",
        ],
        cancellationPolicy:
          "Avisar con al menos 12 horas de anticipación; con más de 15 minutos de retraso la cita se reprograma.",
        cancellationNoticeHours: 12,
        depositPolicy: "Endodoncia y blanqueamiento requieren anticipo para apartar el horario.",
      },
      humanHours: {
        mon: ["09:00", "19:00"],
        tue: ["09:00", "19:00"],
        wed: ["09:00", "19:00"],
        thu: ["09:00", "19:00"],
        fri: ["09:00", "19:00"],
        sat: ["09:00", "14:00"],
        sun: null,
      },
    })
    .returning();
  if (!tenant) throw new Error("No se pudo crear el tenant demo");
  const tenantId = tenant.id;

  const [owner] = await db
    .insert(s.users)
    .values({ email: DEMO_EMAIL, name: "Dueño Demo" })
    .returning();
  if (!owner) throw new Error("No se pudo crear el usuario demo");
  await db.insert(s.memberships).values({ tenantId, userId: owner.id, role: "owner" });

  await db.insert(s.agentConfigs).values({
    tenantId,
    assistantName: "Sonri",
    tone: "cálido y profesional",
    formality: "usted",
    // IDs verificados contra OpenRouter; deben estar en la lista blanca de @empleado/llm.
    model: "anthropic/claude-haiku-5.5",
    fallbackModel: "anthropic/claude-sonnet-5.5",
    autonomy: "copilot",
    escalationRules: ["quejas", "descuentos", "facturas", "urgencias dentales"],
    forbiddenTopics: ["diagnósticos", "opiniones sobre tratamientos de otros dentistas"],
    packSlug: "dental",
    packVersion: "0.1.0",
  });

  // Canal demo con id ficticio: el real (phone_number_id de Meta) se conecta desde el panel.
  await db.insert(s.channels).values({
    tenantId,
    type: "whatsapp",
    externalId: "demo-sonrisa-0001",
    displayPhone: "+52 999 000 0000",
  });

  const serviceRows = await db
    .insert(s.services)
    .values([
      { tenantId, name: "Valoración dental", durationMin: 30, bufferMin: 10, priceCents: 30000, description: "Revisión general y plan de tratamiento." },
      { tenantId, name: "Limpieza dental", durationMin: 45, bufferMin: 10, priceCents: 60000 },
      { tenantId, name: "Resina", durationMin: 60, bufferMin: 10, priceCents: 90000 },
      { tenantId, name: "Endodoncia", durationMin: 90, bufferMin: 15, priceCents: 350000, requiresDeposit: true },
      { tenantId, name: "Extracción", durationMin: 45, bufferMin: 15, priceCents: 120000 },
      { tenantId, name: "Blanqueamiento", durationMin: 60, bufferMin: 10, priceCents: 280000, requiresDeposit: true },
      { tenantId, name: "Valoración de ortodoncia", durationMin: 30, bufferMin: 10, priceCents: 50000 },
    ])
    .returning();
  const svc = Object.fromEntries(serviceRows.map((r) => [r.name, r.id])) as Record<string, string>;

  const [ruiz, mena] = await db
    .insert(s.staff)
    .values([
      { tenantId, name: "Dra. Mónica Ruiz", roleLabel: "Odontóloga general" },
      { tenantId, name: "Dr. Andrés Mena", roleLabel: "Endodoncista y ortodoncista" },
    ])
    .returning();
  if (!ruiz || !mena) throw new Error("No se pudo crear el personal demo");

  const link = (staffId: string, names: string[]) =>
    names.map((n) => ({ tenantId, staffId, serviceId: svc[n]! }));
  await db.insert(s.staffServices).values([
    ...link(ruiz.id, ["Valoración dental", "Limpieza dental", "Resina", "Extracción", "Blanqueamiento"]),
    ...link(mena.id, ["Valoración dental", "Endodoncia", "Extracción", "Valoración de ortodoncia"]),
  ]);

  // Horario general (lun-vie 9-19, sab 9-14) y un horario propio para el Dr. Mena.
  await db.insert(s.businessHours).values([
    ...[1, 2, 3, 4, 5].map((weekday) => ({ tenantId, weekday, opens: "09:00", closes: "19:00" })),
    { tenantId, weekday: 6, opens: "09:00", closes: "14:00" },
    ...[1, 3, 5].map((weekday) => ({ tenantId, staffId: mena.id, weekday, opens: "09:00", closes: "15:00" })),
  ]);

  await db.insert(s.businessHolidays).values([
    { tenantId, date: "2026-12-25", reason: "Navidad" },
    { tenantId, date: "2027-01-01", reason: "Año Nuevo" },
  ]);

  await db.insert(s.knowledgeDocs).values({
    tenantId,
    title: "Preguntas frecuentes",
    sourceType: "text",
    rawText: FAQ,
    status: "pending", // se vectoriza en el paso de conocimiento (RAG)
  });

  console.log(`Seed listo: "${tenant.name}" (${tenantId}), ${serviceRows.length} servicios, 2 dentistas.`);
} finally {
  await close();
}
