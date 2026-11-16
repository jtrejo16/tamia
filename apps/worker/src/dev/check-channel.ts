/**
 * Diagnostico del canal de WhatsApp de un negocio: comprueba que el token guardado
 * (cifrado) funciona preguntandole a Meta por el numero. Solo LEE; nunca muestra el token.
 *
 *   pnpm --filter @empleado/worker check-channel -- --slug sonrisa
 */
import { openChannelCredentials } from "@empleado/channels";
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

const slug = arg("slug");
if (!slug) {
  console.error("Indica el negocio: --slug sonrisa");
  process.exit(1);
}
const { DATABASE_URL, ENCRYPTION_KEY } = process.env;
if (!DATABASE_URL || !ENCRYPTION_KEY) {
  console.error("Faltan DATABASE_URL o ENCRYPTION_KEY en .env");
  process.exit(1);
}

// Siempre contra el Graph API REAL (ignora GRAPH_BASE_URL a proposito), salvo --base.
const base = (arg("base") ?? "https://graph.facebook.com").replace(/\/$/, "");
const version = process.env.GRAPH_API_VERSION || "v23.0";

const { db, close } = createDb(DATABASE_URL, { max: 1 });
let exitCode = 0;
try {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, slug));
  if (!tenant) throw new Error(`No existe el negocio "${slug}"`);
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.tenantId, tenant.id), eq(channels.type, "whatsapp")));
  if (!channel) throw new Error("El negocio no tiene canal de WhatsApp");

  console.log(`Negocio:        ${tenant.name}`);
  console.log(`phone_number_id: ${channel.externalId}`);
  console.log(`Estado del canal: ${channel.status}`);
  console.log(`Token guardado:  ${channel.credentialsEnc ? "sí (cifrado)" : "NO"}`);
  if (!channel.credentialsEnc) throw new Error("Falta guardar el token (connect-channel)");

  const { accessToken } = openChannelCredentials(channel.credentialsEnc, parseKey(ENCRYPTION_KEY), tenant.id, channel.id);
  if (accessToken.startsWith("dev-token")) {
    console.log("\nEl token guardado es el de DESARROLLO (para el Graph falso), no uno real de Meta.");
    exitCode = 2;
  } else {
    const fields = "verified_name,display_phone_number,quality_rating,name_status,code_verification_status,platform_type";
    const res = await fetch(`${base}/${version}/${encodeURIComponent(channel.externalId)}?fields=${fields}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
      error?: { message?: string; code?: number };
    };
    if (!res.ok || json.error) {
      console.log(`\nMeta rechazó la consulta (HTTP ${res.status}, código ${json.error?.code ?? "?"}): ${json.error?.message ?? "sin detalle"}`);
      if (json.error?.code === 190) console.log("→ El token es inválido o venció: genera uno nuevo y vuelve a correr connect-channel.");
      if (json.error?.code === 100 || json.error?.code === 10) console.log("→ El token no tiene acceso a este número: revisa los activos y permisos del usuario del sistema.");
      exitCode = 1;
    } else {
      console.log("\n✓ Meta aceptó el token. Datos del número en Meta:");
      console.log(`  Nombre verificado:   ${json.verified_name}`);
      console.log(`  Número:              ${json.display_phone_number}`);
      console.log(`  Estado del nombre:   ${json.name_status}`);
      console.log(`  Calidad:             ${json.quality_rating}`);
      console.log(`  Verificación código: ${json.code_verification_status}`);
      console.log(`  Plataforma:          ${json.platform_type}`);
    }
  }

  // App Secret: se valida pidiendo a Meta los datos de la app con el token de app "id|secreto".
  const appId = arg("app-id") ?? process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  console.log("");
  if (!appSecret || appSecret.includes("solo-para-desarrollo")) {
    console.log("App Secret:      sigue siendo el de desarrollo (pon el real en .env como META_APP_SECRET)");
    exitCode ||= 2;
  } else if (!appId) {
    console.log("App Secret:      no se pudo validar: indica la app con --app-id <ID de tu app de Meta>");
  } else {
    const res = await fetch(`${base}/${version}/${encodeURIComponent(appId)}?fields=name`, {
      headers: { Authorization: `Bearer ${appId}|${appSecret}` },
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { name?: string; error?: { message?: string; code?: number } };
    if (res.ok && json.name) {
      console.log(`✓ App Secret válido para la app "${json.name}" (${appId}).`);
    } else {
      console.log(`✗ Meta no aceptó el App Secret para la app ${appId} (código ${json.error?.code ?? res.status}): ${json.error?.message ?? "sin detalle"}`);
      console.log("  → Cópialo de nuevo de tu app → Configuración → Básica → Clave secreta de la app.");
      exitCode = 1;
    }
  }
} catch (error) {
  console.error(`\n✗ ${error instanceof Error ? error.message : error}`);
  exitCode = 1;
} finally {
  await close();
}
process.exit(exitCode);
