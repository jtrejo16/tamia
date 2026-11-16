/**
 * Datos de ejemplo para ENSEÑAR el panel: tres conversaciones (una normal, una escalada y una
 * con un borrador por aprobar) y algunas citas, en la clinica demo. Es idempotente: borra y
 * vuelve a crear solo sus propios contactos (telefonos +52199900000xx).
 *
 *   pnpm --filter @empleado/inbox demo-data
 *
 * No envia nada a nadie: los mensajes salientes de ejemplo ya estan "sent" y los clientes son
 * ficticios. (Aprobar el borrador de ejemplo SI deja un mensaje en cola: no arranques el worker.)
 */
import {
  appointments, approvals, channels, contacts, conversations, createDb, handoffs,
  messages, services, staff, tenants,
} from "@empleado/db";
import { addDays, localDate, weekdayOf, zonedTimeToUtc } from "@empleado/scheduling";
import { and, eq, like } from "drizzle-orm";

for (const path of ["../../.env", ".env"]) {
  try {
    process.loadEnvFile(path);
    break;
  } catch {
    /* siguiente */
  }
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Falta DATABASE_URL en .env");

const { db, close } = createDb(url, { max: 1 });
const PHONE_PREFIX = "+52199900000";
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000);

try {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, "sonrisa"));
  if (!tenant) throw new Error('No existe el negocio "sonrisa": corre primero el seed.');
  const tenantId = tenant.id;
  const [channel] = await db.select().from(channels).where(and(eq(channels.tenantId, tenantId), eq(channels.type, "whatsapp")));
  if (!channel) throw new Error("El negocio no tiene canal de WhatsApp");
  const [service] = await db.select().from(services).where(and(eq(services.tenantId, tenantId), eq(services.name, "Limpieza dental")));
  const [dra] = await db.select().from(staff).where(and(eq(staff.tenantId, tenantId), like(staff.name, "%Ruiz%")));
  if (!service || !dra) throw new Error("Faltan servicios o personal de la clinica demo");

  // Borrar los ejemplos anteriores (las FK en cascada limpian conversaciones, mensajes y citas).
  await db.delete(contacts).where(and(eq(contacts.tenantId, tenantId), like(contacts.phoneE164, `${PHONE_PREFIX}%`)));

  const mk = async (n: number, name: string | null, wa: string) => {
    const [c] = await db
      .insert(contacts)
      .values({ tenantId, phoneE164: `${PHONE_PREFIX}${String(n).padStart(2, "0")}`, displayName: name, profile: { whatsapp_name: wa } })
      .returning();
    return c!;
  };
  const conv = async (contactId: string, lastInboundMinAgo: number, state: "bot" | "human" = "bot") => {
    const [v] = await db
      .insert(conversations)
      .values({ tenantId, contactId, channelId: channel.id, state, lastInboundAt: ago(lastInboundMinAgo), lastMessageAt: ago(lastInboundMinAgo) })
      .returning();
    return v!;
  };
  const say = (conversationId: string, direction: "in" | "out", body: string, minAgo: number, sender?: "bot" | "human") =>
    db.insert(messages).values({
      tenantId, conversationId, channelId: channel.id, direction, body,
      sender: direction === "in" ? "contact" : (sender ?? "bot"), type: "text",
      status: direction === "in" ? "received" : "read", createdAt: ago(minAgo),
    });

  // 1) Conversacion normal atendida por el asistente.
  const ana = await mk(1, "Ana Torres", "Ana 🌸");
  const c1 = await conv(ana.id, 18);
  await say(c1.id, "in", "Hola, buenas tardes. ¿Cuánto cuesta una limpieza?", 22);
  await say(c1.id, "out", "¡Buenas tardes! Soy Sonri, el asistente virtual de Clínica Dental Sonrisa. La limpieza dental cuesta *$600 MXN*, dura 45 minutos y la realiza la Dra. Mónica Ruiz. No requiere anticipo.\n\n¿Le gustaría agendar una cita?", 21);
  await say(c1.id, "in", "Sí, ¿tienen lugar mañana por la tarde?", 18);

  // 2) Escalada urgente: el asistente se pausó y una persona debe atender.
  const luis = await mk(2, null, "Luis M.");
  const c2 = await conv(luis.id, 6, "human");
  await say(c2.id, "in", "Buenas, me duele muchísimo una muela y se me hinchó la cara", 9);
  await say(c2.id, "out", "Lamento mucho lo que siente. Por la inflamación y el dolor intenso, le recomiendo acudir de inmediato a la clínica o a urgencias. Ya pasé su caso a la recepción con prioridad alta y le contestarán en breve.", 8);
  await say(c2.id, "in", "¿Pueden atenderme ahorita? Estoy cerca", 6);
  await db.insert(handoffs).values({ tenantId, conversationId: c2.id, reason: "Dolor intenso e inflamación de la cara", urgency: "alta", notifiedAt: ago(8) });

  // 3) Modo copiloto: el asistente dejo un borrador que propone agendar.
  const maria = await mk(3, "María López", "Mary");
  const c3 = await conv(maria.id, 4);
  await say(c3.id, "in", "Quiero una limpieza, lo más pronto que tengan por la mañana", 7);
  await say(c3.id, "out", "Con gusto, María. Tengo disponible el siguiente horario con la Dra. Mónica Ruiz. ¿Le confirmo la cita?", 6);
  await say(c3.id, "in", "Sí, confírmame por favor", 4);

  // Primer dia habil de la semana proxima a las 10:00 (hora de Merida).
  const tz = tenant.timezone;
  let day = addDays(localDate(new Date(), tz), 2);
  while (weekdayOf(day) === 0 || weekdayOf(day) === 6) day = addDays(day, 1);
  const start = zonedTimeToUtc(day, 10 * 60, tz);
  await db.insert(approvals).values({
    tenantId,
    conversationId: c3.id,
    draft: "Listo, María: dejé registrada su limpieza dental con la Dra. Mónica Ruiz. El equipo se la confirma en breve. ¡Gracias por elegirnos!",
    proposedActions: [
      {
        tool: "crear_cita",
        args: { servicio_id: service.id, empleado_id: dra.id, inicio_iso: start.toISOString() },
        summary: `Cita de Limpieza dental con ${dra.name}, ${new Intl.DateTimeFormat("es-MX", { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hour12: false }).format(start)} (45 min), costo $600 MXN, a nombre de María López.`,
      },
    ],
  });

  // Algunas citas para la pantalla de Citas.
  const slot = (dayOffset: number, hour: number) => {
    let d = addDays(localDate(new Date(), tz), dayOffset);
    while (weekdayOf(d) === 0) d = addDays(d, 1);
    return zonedTimeToUtc(d, hour * 60, tz);
  };
  const mkAppt = (contactId: string, s: Date, status: "confirmed" | "pending", confirmed = false) =>
    db.insert(appointments).values({
      tenantId, contactId, serviceId: service.id, staffId: dra.id, startsAt: s,
      endsAt: new Date(s.getTime() + 45 * 60_000), status, confirmedByContact: confirmed,
    });
  await mkAppt(ana.id, slot(1, 11), "confirmed", true);
  await mkAppt(luis.id, slot(1, 16), "pending");

  console.log("Datos de ejemplo creados: 3 conversaciones (normal, escalada urgente y con borrador por aprobar) y 2 citas.");
} finally {
  await close();
}
