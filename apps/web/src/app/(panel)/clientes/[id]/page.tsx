import { notFound } from "next/navigation";
import { CustomerDetailView } from "@/components/customer-detail-view";

export const metadata = { title: "Cliente · Jovia" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <CustomerDetailView id={id} />;
}
