import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { loadEnv, requireEnv } from "./env";

loadEnv();

// Conexion del PROPIETARIO (DATABASE_URL): solo para migraciones y seed.
const client = postgres(requireEnv("DATABASE_URL"), { max: 1, onnotice: () => {} });

try {
  // Extensiones requeridas antes de crear tablas (vector) y restricciones (btree_gist).
  await client.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
  await client.unsafe("CREATE EXTENSION IF NOT EXISTS btree_gist");

  await migrate(drizzle(client), { migrationsFolder: "./migrations" });

  // El rol de la app se crea NOLOGIN en la migracion; aqui se le da contrasena desde el entorno.
  const appPassword = requireEnv("APP_DB_PASSWORD");
  await client.unsafe(
    `ALTER ROLE empleado_app WITH LOGIN PASSWORD '${appPassword.replaceAll("'", "''")}'`,
  );
  console.log("Migraciones aplicadas y rol empleado_app listo.");

  // Alta del operador sin entrar a la base de datos: define OPERATOR_EMAIL en el servicio de migraciones y
  // vuelve a desplegarlo. La persona debe haberse registrado antes (/registro). Es idempotente.
  const operatorEmail = process.env.OPERATOR_EMAIL?.trim().toLowerCase();
  if (operatorEmail) {
    const updated = await client`update users set is_operator = true, updated_at = now() where lower(email) = ${operatorEmail} returning id`;
    console.log(updated.length > 0 ? `Operador de la plataforma: ${operatorEmail}` : `OPERATOR_EMAIL: no existe un usuario con ese correo (registrate primero en /registro).`);
  }
} finally {
  await client.end();
}
