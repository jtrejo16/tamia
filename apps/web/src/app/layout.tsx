import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jovia",
  description: "Panel de atención a clientes por WhatsApp",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f766e",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Leer las cabeceras vuelve dinamicas todas las paginas: el nonce de la CSP cambia en cada peticion.
  await headers();
  return (
    <html lang="es-MX">
      <body className="font-sans">{children}</body>
    </html>
  );
}
