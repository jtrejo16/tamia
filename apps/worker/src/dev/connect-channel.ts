/**
 * Conecta (o actualiza) el canal de WhatsApp de un negocio y guarda su token CIFRADO.
 * El token se pide oculto en la terminal: no queda en el historial ni en ningun archivo.
 *
 *   pnpm --filter @empleado/worker connect-channel -- --slug sonrisa
 *       [--phone-number-id 1385124751359472] [--waba-id ...] [--display-phone "+52 1 984 479 0350"]
 *       [--dev-token]      usa un token falso (solo con el Graph API falso)
 */
import { sealChannelCredentials } from "@empleado/channels";
import { channels, createDb, tenants } from "@empleado/db";
import { parseKey } from "@empleado/shared";
import { and, eq } from "drizzle-orm";
import { loadEnv } from "../config";

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
          return resolve(value.trim());
        }
        if (ch === "\u0003") process.exit(130); // Ctrl+C
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const slug = arg("slug");
if (!slug) {
  console.error("Indica el negocio: --slug sonrisa");
  process.exit(1);
}
const databaseUrl = process.env.DATABASE_URL;
const encryptionKey = process.env.ENCRYPTION_KEY;
if (!databaseUrl || !encryptionKey) {
  console.error("Faltan DATABASE_URL o ENCRYPTION_KEY en .env");
  process.exit(1);
}

// Herramienta administrativa: usa el rol propietario (la app nunca crea ni conecta canales sola).
const { db, close } = createDb(databaseUrl, { max: 1 });
try {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, slug));
  if (!tenant) throw new Error(`No existe el negocio "${slug}"`);

  const phoneNumberId = arg("phone-number-id");
  const [existing] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.tenantId, tenant.id), eq(channels.type, "whatsapp")));
  if (!existing) throw new Error("El negocio no tiene un canal de WhatsApp; ejecuta primero el seed.");

  const token = argv.includes("--dev-token")
    ? "dev-token-solo-para-el-graph-falso"
    : await askHidden("Token de acceso de WhatsApp (system user; no se muestra al escribir): ");
  if (token.length < 10) throw new Error("El token parece vacio o demasiado corto");

  await db
    .update(channels)
    .set({
      ...(phoneNumberId ? { externalId: phoneNumberId } : {}),
      ...(arg("waba-id") ? { wabaId: arg("waba-id") } : {}),
      ...(arg("display-phone") ? { displayPhone: arg("display-phone") } : {}),
      credentialsEnc: sealChannelCredentials({ accessToken: token }, parseKey(encryptionKey), tenant.id, existing.id),
      status: "active",
      updatedAt: new Date(),
    })
    .where(eq(channels.id, existing.id));

  console.log(`Canal conectado para "${tenant.name}" (phone_number_id: ${phoneNumberId ?? existing.externalId}). Token guardado cifrado.`);
} finally {
  await close();
}
