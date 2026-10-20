import { getSession } from "@/lib/auth";
import CombosClient from "./CombosClient";

export default async function CombosPage() {
  const session = await getSession();
  return <CombosClient isAdmin={session?.role === "admin"} />;
}
