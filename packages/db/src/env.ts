/** Carga el .env de la raiz del repo (pnpm ejecuta con cwd = packages/db). Ignora si no existe. */
export function loadEnv(): void {
  for (const path of ["../../.env", ".env"]) {
    try {
      process.loadEnvFile(path);
      return;
    } catch {
      // probar el siguiente; en CI las variables ya vienen del entorno
    }
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}
