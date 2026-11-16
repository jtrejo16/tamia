import "server-only";
import type { PanelContext } from "@empleado/inbox";
import { SESSION_TTL_SECONDS, createSessionToken, verifySessionToken, type SessionPayload } from "@empleado/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "./server";

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

/** Sesion valida o null. Nunca lanza por una cookie rota. */
export async function readSession(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  try {
    return verifySessionToken(token, secret());
  } catch {
    return null;
  }
}

export const toContext = (s: SessionPayload): PanelContext => ({ tenantId: s.tid, userId: s.uid, role: s.role });

/** Para paginas: sin sesion, manda a /login. */
export async function requireContext(): Promise<PanelContext> {
  const session = await readSession();
  if (!session) redirect("/login");
  return toContext(session);
}
