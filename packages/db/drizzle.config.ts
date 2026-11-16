import { defineConfig } from "drizzle-kit";

// pnpm ejecuta los scripts con cwd = packages/db, el .env vive en la raiz del repo.
try {
  process.loadEnvFile("../../.env");
} catch {
  // En CI las variables vienen del entorno.
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
