import { getSession } from "@/lib/auth";
import ConfigClient from "./ConfigClient";

export default async function ConfigPage() {
  const session = await getSession();
  return <ConfigClient role={session?.role ?? "user"} />;
}
