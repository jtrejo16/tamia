import {
  isOperator,
  operatorListTenants,
  operatorSetComped,
  operatorSetTenantStatus,
  operatorSetVertical,
  type Database,
  type OperatorTenantRow,
} from "@empleado/db";
import { applyStarterMenu } from "./starter";
import { dataCollectionFor } from "@empleado/llm";
import { VERTICAL_IDS } from "@empleado/shared";
import { fail, type Failure, type Success } from "./types";

/**
 * Panel de operador (el dueno de la plataforma). El permiso lo decide la BASE DE DATOS segun el
 * usuario de la sesion (users.is_operator), no una variable ni la cookie.
 */
export type OperatorError = "forbidden" | "not_found" | "invalid";

export async function operatorTenants(db: Database, userId: string): Promise<Success<{ items: OperatorTenantRow[] }> | Failure<OperatorError>> {
  if (!(await isOperator(db, userId))) return fail("forbidden");
  return { ok: true, items: await operatorListTenants(db, userId) };
}

export async function operatorChangeStatus(db: Database, userId: string, tenantId: string, status: unknown): Promise<Success | Failure<OperatorError>> {
  if (status !== "active" && status !== "paused" && status !== "cancelled") return fail("invalid");
  if (!(await isOperator(db, userId))) return fail("forbidden");
  return (await operatorSetTenantStatus(db, userId, tenantId, status)) ? { ok: true } : fail("not_found");
}

/**
 * Cambia el giro de un negocio: su giro y el pack de instrucciones del asistente, juntos. NO toca servicios, preguntas
 * frecuentes ni conocimiento (siguen siendo los del giro anterior). `privacyChanged` avisa si cambia la politica de datos con el
 * modelo de IA (los giros de salud van con restriccion y los demas no).
 */
export async function operatorChangeVertical(
  db: Database,
  userId: string,
  tenantId: string,
  vertical: unknown,
): Promise<Success<{ previous: string; changed: boolean; starterApplied: boolean; privacyChanged: boolean }> | Failure<OperatorError>> {
  if (typeof vertical !== "string" || !(VERTICAL_IDS as readonly string[]).includes(vertical)) return fail("invalid");
  if (!(await isOperator(db, userId))) return fail("forbidden");
  const previous = await operatorSetVertical(db, userId, tenantId, vertical);
  if (previous === null) return fail("not_found");
  // Si el giro nuevo es de restaurante y su menu esta vacio, arranca con el menu de ejemplo (si ya hay menu, no se toca).
  const starter = previous !== vertical ? await applyStarterMenu(db, tenantId, vertical).catch(() => null) : null;
  return { ok: true, previous, changed: previous !== vertical, starterApplied: starter?.applied === true, privacyChanged: dataCollectionFor(previous) !== dataCollectionFor(vertical) };
}

export async function operatorChangeComped(db: Database, userId: string, tenantId: string, on: boolean): Promise<Success | Failure<OperatorError>> {
  if (!(await isOperator(db, userId))) return fail("forbidden");
  return (await operatorSetComped(db, userId, tenantId, on)) ? { ok: true } : fail("not_found");
}
