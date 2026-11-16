/**
 * Marca (o desmarca) a un usuario como operador de la plataforma (el dueno del SaaS).
 *
 *   pnpm db:operator -- --email demo@sonrisa.test [--off]
 */
import { eq } from "drizzle-orm";
import { createDb } from "./client";
import { loadEnv, requireEnv } from "./env";
import { users } from "./schema";

loadEnv();
const argv = process.argv.slice(2);
const i = argv.indexOf("--email");
const email = i >= 0 ? argv[i + 1] : undefined;
if (!email) {
  console.error("Indica el correo: --email demo@sonrisa.test");
  process.exit(1);
}
const on = !argv.includes("--off");

const { db, close } = createDb(requireEnv("DATABASE_URL"), { max: 1 });
try {
  const updated = await db.update(users).set({ isOperator: on, updatedAt: new Date() }).where(eq(users.email, email)).returning({ id: users.id });
  if (updated.length === 0) throw new Error(`No existe el usuario ${email}`);
  console.log(`${email} ${on ? "ahora es" : "ya no es"} operador de la plataforma.`);
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await close();
}
