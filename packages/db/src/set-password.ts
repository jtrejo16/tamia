/**
 * Fija la contrasena de un usuario del panel (herramienta administrativa, rol propietario).
 *
 *   pnpm --filter @empleado/db set-password -- --email demo@sonrisa.test
 *       [--from-env DEMO_OWNER_PASSWORD]   lee la contrasena de esa variable de .env
 *
 * Sin --from-env la pide oculta en la terminal: no queda en el historial.
 */
import { hashPassword } from "@empleado/shared";
import { eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { loadEnv, requireEnv } from "./env";
import { users } from "./schema";

loadEnv();
const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const email = arg("email");
if (!email) {
  console.error("Indica el correo: --email demo@sonrisa.test");
  process.exit(1);
}

const fromEnv = arg("from-env");
const password = fromEnv ? (process.env[fromEnv] ?? "") : await askHidden("Nueva contraseña (no se muestra): ");

const { db, close } = createDb(requireEnv("DATABASE_URL"), { max: 1 });
try {
  const hash = await hashPassword(password); // valida la longitud minima
  const updated = await db
    .update(users)
    // Subir la version cierra las sesiones abiertas con la contrasena anterior.
    .set({ passwordHash: hash, sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: new Date() })
    .where(eq(users.email, email))
    .returning({ id: users.id });
  if (updated.length === 0) throw new Error(`No existe el usuario ${email}`);
  console.log(`Contraseña actualizada para ${email}.`);
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await close();
}
