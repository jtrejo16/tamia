import { handleMercadoPagoEvent, verifyMercadoPagoSignature } from "@empleado/inbox";
import { NextResponse, type NextRequest } from "next/server";
import { getDb, getMercadoPago, notifyChange } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * Avisos de Mercado Pago (suscripciones). Publica por naturaleza: se acepta SOLO si la firma
 * HMAC es valida con MERCADOPAGO_WEBHOOK_SECRET. Aun asi no se confia en el contenido: el estado
 * real se consulta a la API de Mercado Pago con nuestro token.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET?.trim();
  const mp = getMercadoPago();
  if (!secret || !mp) return NextResponse.json({ ok: false }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { type?: string; topic?: string; data?: { id?: string | number } };
  // MP manda el id en la URL (data.id) y en el cuerpo; la firma se calcula con el de la URL.
  const dataId = req.nextUrl.searchParams.get("data.id") ?? (body.data?.id != null ? String(body.data.id) : null);
  const type = req.nextUrl.searchParams.get("type") ?? body.type ?? body.topic ?? "";

  const valid = verifyMercadoPagoSignature({
    secret,
    signatureHeader: req.headers.get("x-signature"),
    requestId: req.headers.get("x-request-id"),
    dataId,
  });
  if (!valid || !dataId) return NextResponse.json({ ok: false }, { status: 401 });

  try {
    const { applied } = await handleMercadoPagoEvent(getDb(), mp, { type, dataId });
    if (applied) notifyChange();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[mp-webhook]", error instanceof Error ? error.message : error);
    // 500 => Mercado Pago reintenta mas tarde.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
