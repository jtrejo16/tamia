import { Suspense } from "react";
import { InboxView } from "@/components/inbox-view";

export const metadata = { title: "Bandeja · Jovia" };

export default function InboxPage() {
  // useSearchParams (la conversacion abierta va en la direccion) exige Suspense.
  return (
    <Suspense>
      <InboxView />
    </Suspense>
  );
}
