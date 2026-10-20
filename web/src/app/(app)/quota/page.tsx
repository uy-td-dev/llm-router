import { getSession } from "@/lib/auth";
import QuotaClient from "./QuotaClient";

export default async function QuotaPage() {
  const session = await getSession();
  return <QuotaClient isAdmin={session?.role === "admin"} />;
}
