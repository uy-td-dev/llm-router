import { getSession } from "@/lib/auth";
import ProvidersClient from "./ProvidersClient";

export default async function ProvidersPage() {
  const session = await getSession();
  return <ProvidersClient role={session?.role ?? "user"} />;
}
