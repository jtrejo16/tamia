import { businessHours, channels, deliveryZones, menuItems, notificationSettings, restaurantSettings, services, staff, tenants, withTenant, type Database } from "@empleado/db";
import { hasModule, modulesFor } from "@empleado/shared";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { PanelContext } from "./types";

/**
 * Lista de arranque («Primeros pasos»): que le falta al negocio para quedar listo y el porcentaje de avance. Se calcula con lo
 * que YA hay en la base (no guarda nada): al cumplir cada paso, solo se marca. Los pasos dependen de los modulos del negocio.
 * Los «opcionales» se muestran pero no cuentan para el porcentaje.
 */

export interface OnboardingStep {
  id: string;
  label: string;
  hint: string;
  done: boolean;
  optional: boolean;
  /** Pantalla del panel donde se hace. */
  href: string;
}

export interface OnboardingView {
  percent: number;
  doneCount: number;
  total: number;
  steps: OnboardingStep[];
  /** El negocio arranco con un menu de ejemplo (para avisar que debe revisarlo). */
  starterMenu: { template: string; reviewed: boolean } | null;
}

export async function getOnboarding(db: Database, ctx: PanelContext): Promise<OnboardingView> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [t] = await tx.select({ vertical: tenants.vertical, profile: tenants.profile }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const profile = t?.profile ?? {};
    const modules = modulesFor(t?.vertical, profile.modules);
    const count = async (q: Promise<Array<{ n: number }>>) => Number((await q)[0]?.n ?? 0);

    const [channelsN, hoursN] = await Promise.all([
      count(tx.select({ n: sql<number>`count(*)::int` }).from(channels).where(and(eq(channels.status, "active"), ne(channels.type, "voice")))),
      count(tx.select({ n: sql<number>`count(*)::int` }).from(businessHours).where(isNull(businessHours.staffId))),
    ]);
    const [alerts] = await tx.select().from(notificationSettings);
    const alertsOn = Boolean(alerts?.enabled && alerts.recipients.some((r) => r.enabled));

    const steps: OnboardingStep[] = [
      { id: "business", label: "Cuenta de qué trata tu negocio", hint: "Una descripción corta y la dirección: el asistente las usa para contestar.", done: Boolean(profile.description?.trim() && profile.address?.trim()), optional: false, href: "/configuracion?tab=negocio" },
      { id: "hours", label: "Define tu horario", hint: "Los días y horas en que atiendes.", done: hoursN > 0, optional: false, href: "/configuracion?tab=horarios" },
      { id: "channel", label: "Conecta tu WhatsApp", hint: "Para que el asistente conteste a tus clientes.", done: channelsN > 0, optional: false, href: "/configuracion?tab=whatsapp" },
      { id: "alerts", label: "Activa los avisos al equipo", hint: "Un correo o WhatsApp para enterarte cuando alguien necesita a una persona" + (hasModule(modules, "restaurante") ? " y cuando entra un pedido." : "."), done: alertsOn, optional: false, href: "/configuracion?tab=avisos" },
    ];

    if (hasModule(modules, "citas")) {
      const [servicesN, staffN] = await Promise.all([
        count(tx.select({ n: sql<number>`count(*)::int` }).from(services)),
        count(tx.select({ n: sql<number>`count(*)::int` }).from(staff)),
      ]);
      steps.push(
        { id: "services", label: "Agrega tus servicios", hint: "Con su duración y precio.", done: servicesN > 0, optional: false, href: "/configuracion?tab=servicios" },
        { id: "staff", label: "Agrega a tu equipo", hint: "Quién atiende cada servicio.", done: staffN > 0, optional: false, href: "/configuracion?tab=equipo" },
      );
    }

    if (hasModule(modules, "restaurante")) {
      const [itemsN, settingsN, zonesN] = await Promise.all([
        count(tx.select({ n: sql<number>`count(*)::int` }).from(menuItems)),
        count(tx.select({ n: sql<number>`count(*)::int` }).from(restaurantSettings)),
        count(tx.select({ n: sql<number>`count(*)::int` }).from(deliveryZones).where(eq(deliveryZones.active, true))),
      ]);
      const [rs] = await tx.select({ delivery: restaurantSettings.deliveryEnabled, reservations: restaurantSettings.reservationsEnabled }).from(restaurantSettings);
      const starter = profile.starterMenu ?? null;
      steps.push(
        { id: "menu", label: "Carga tu menú", hint: "Platillos, precios y modificadores. Puedes importar un CSV.", done: itemsN > 0, optional: false, href: "/menu" },
        ...(starter ? [{ id: "menu_reviewed", label: "Revisa el menú de ejemplo", hint: "Empezaste con un menú de ejemplo: cambia platillos y precios por los tuyos.", done: starter.reviewed, optional: false, href: "/menu" }] : []),
        { id: "orders", label: "Revisa tus ajustes de pedidos", hint: "Tiempo de preparación, pedido mínimo y formas de pago.", done: settingsN > 0, optional: false, href: "/pedidos" },
        { id: "delivery", label: "Entrega a domicilio", hint: "Si repartes, da de alta tus zonas y el costo de envío.", done: Boolean(rs?.delivery) && zonesN > 0, optional: true, href: "/pedidos" },
        { id: "reservations", label: "Reservaciones de mesa", hint: "Si aceptas reservaciones, define tu aforo y tus reglas.", done: Boolean(rs?.reservations), optional: true, href: "/reservaciones" },
      );
    }

    const required = steps.filter((s) => !s.optional);
    const doneCount = required.filter((s) => s.done).length;
    return {
      percent: required.length === 0 ? 100 : Math.round((doneCount / required.length) * 100),
      doneCount,
      total: required.length,
      steps,
      starterMenu: profile.starterMenu ?? null,
    };
  });
}
