import { getSession } from "@/lib/auth";
import TokenSaverClient from "./TokenSaverClient";

export default async function TokenSaverPage() {
  const session = await getSession();
  return <TokenSaverClient isAdmin={session?.role === "admin"} />;
}
