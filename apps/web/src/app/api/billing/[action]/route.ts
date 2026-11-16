import { cancelSubscription, refreshFromProvider, startCheckout } from "@empleado/inbox";
import { authed, failure, readJson, respond } from "@/lib/api";
import { getDb, getMercadoPago, publicBaseUrl } from "@/lib/server";
import { getValidSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** checkout | cancel | refresh — solo el dueño. */
export const POST = authed<{ action: string }>(async (req, ctx, { action }) => {
  const db = getDb();
  const mp = getMercadoPago();
  if (action === "checkout") {
    const body = await readJson(req);
    const valid = await getValidSession(); // memoizada: la misma verificacion de authed
    if (!valid) return failure("unauthorized");
    const base = publicBaseUrl(req.nextUrl.origin);
    return respond(
      await startCheckout(db, ctx, mp, { plan: body.plan, payerEmail: valid.state.email, backUrl: `${base}/facturacion?volvio=1` }),
    );
  }
  if (action === "cancel") return respond(await cancelSubscription(db, ctx, mp));
  if (action === "refresh") return respond(await refreshFromProvider(db, ctx, mp));
  return failure("not_found");
});
