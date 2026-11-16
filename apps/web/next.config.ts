import type { NextConfig } from "next";

// El .env vive en la raiz del repo (compartido con el worker), no en apps/web.
for (const path of ["../../.env", ".env"]) {
  try {
    process.loadEnvFile(path);
    break;
  } catch {
    /* siguiente */
  }
}

const config: NextConfig = {
  // Los paquetes del monorepo se exportan como TypeScript: Next debe compilarlos.
  transpilePackages: [
    "@empleado/agent",
    "@empleado/channels",
    "@empleado/db",
    "@empleado/inbox",
    "@empleado/llm",
    "@empleado/queue",
    "@empleado/scheduling",
    "@empleado/shared",
  ],
  serverExternalPackages: ["postgres", "bullmq", "ioredis"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default config;
