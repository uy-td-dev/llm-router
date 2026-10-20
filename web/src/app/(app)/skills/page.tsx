import { getSession } from "@/lib/auth";
import SkillsClient from "./SkillsClient";

export default async function SkillsPage() {
  const session = await getSession();
  return <SkillsClient isAdmin={session?.role === "admin"} />;
}
