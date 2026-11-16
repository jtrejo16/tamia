import {
  isOperator,
  operatorListTenants,
  operatorSetComped,
  operatorSetTenantStatus,
  type Database,
  type OperatorTenantRow,
} from "@empleado/db";
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

export async function operatorChangeComped(db: Database, userId: string, tenantId: string, on: boolean): Promise<Success | Failure<OperatorError>> {
  if (!(await isOperator(db, userId))) return fail("forbidden");
  return (await operatorSetComped(db, userId, tenantId, on)) ? { ok: true } : fail("not_found");
}
