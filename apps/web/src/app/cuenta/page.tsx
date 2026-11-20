import { AccountView } from "@/components/account-view";
import { requireValidSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mi cuenta · Jovia" };

/** Fuera del panel a proposito: debe poder abrirse aunque la contraseña sea temporal. */
export default async function AccountPage({ searchParams }: { searchParams: Promise<{ obligatorio?: string }> }) {
  const { state } = await requireValidSession();
  const { obligatorio } = await searchParams;
  return (
    <AccountView
      name={state.userName ?? state.email}
      email={state.email}
      tenantName={state.tenantName}
      mustChange={state.mustChangePassword || obligatorio === "1"}
    />
  );
}
