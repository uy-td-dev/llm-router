import { getSession } from "@/lib/auth";
import ProviderDetail from "./ProviderDetail";

export default async function ProviderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  return <ProviderDetail id={id} isAdmin={session?.role === "admin"} />;
}
