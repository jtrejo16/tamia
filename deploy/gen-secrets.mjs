// Genera los secretos NUEVOS de un entorno (produccion o pruebas). Imprime lineas listas para pegar en
// .env.production. No guarda nada en disco. Los valores de contrasena son hexadecimales (sin simbolos
// que compliquen las direcciones de conexion).
//   pnpm deploy:secrets
import { randomBytes } from "node:crypto";

const hex = (n) => randomBytes(n).toString("hex");
const lines = [
  `POSTGRES_PASSWORD=${hex(24)}`,
  `APP_DB_PASSWORD=${hex(24)}`,
  `REDIS_PASSWORD=${hex(24)}`,
  `AUTH_SECRET=${randomBytes(48).toString("base64url")}`,
  // 32 bytes en base64: llave AES-256 que cifra las claves de WhatsApp/Facebook guardadas.
  `ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
  `WHATSAPP_VERIFY_TOKEN=${hex(16)}`,
];
console.log("# Pega estas lineas en tu .env.production (secretos NUEVOS; no reutilices los de desarrollo).");
console.log("# GUARDA una copia de ENCRYPTION_KEY en un gestor de contrasenas: si se pierde, las claves de");
console.log("# WhatsApp ya guardadas no se pueden descifrar y hay que reconectar cada canal.\n");
for (const l of lines) console.log(l);
