import { getSession } from "@/lib/auth";
import ProxyPoolsClient from "./ProxyPoolsClient";

export default async function ProxyPoolsPage() {
  const session = await getSession();
  return <ProxyPoolsClient isAdmin={session?.role === "admin"} />;
}
