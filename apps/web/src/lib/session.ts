import "server-only";
import { getSessionState, type PanelContext, type SessionState } from "@empleado/inbox";
import { SESSION_TTL_SECONDS, createSessionToken, verifySessionToken, type SessionPayload } from "@empleado/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { env, getDb } from "./server";

export const SESSION_COOKIE = "ed_session";

const secret = () => env("AUTH_SECRET");

export async function startSession(data: Omit<SessionPayload, "exp">): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, createSessionToken(data, secret()), {
    httpOnly: true, // JavaScript del navegador no puede leerla
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** La cookie firmada, sin consultar la base de datos. Nunca lanza por una cookie rota. */
export async function readSession(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  try {
    return verifySessionToken(token, secret());
  } catch {
    return null;
  }
}

export interface ValidSession {
  session: SessionPayload;
  state: Extract<SessionState, { ok: true }>;
  ctx: PanelContext;
}

/**
 * Sesion VERIFICADA: firma valida + la base de datos confirma que no se revoco, que el
 * usuario sigue en el negocio y cual es su rol vigente. Se memoiza por peticion.
 */
export const getValidSession = cache(async (): Promise<ValidSession | null> => {
  const session = await readSession();
  if (!session) return null;
  const state = await getSessionState(getDb(), session);
  if (!state.ok) return null;
  return { session, state, ctx: { tenantId: session.tid, userId: session.uid, role: state.role } };
});

/** Para paginas: sin sesion valida, manda a limpiar la cookie y a /login. */
export async function requireValidSession(): Promise<ValidSession> {
  const valid = await getValidSession();
  if (!valid) redirect((await readSession()) ? "/sesion-invalida" : "/login");
  return valid;
}
