import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import TeamsClient from "./TeamsClient";

export default async function TeamsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role === "user") redirect("/endpoint");
  return (
    <TeamsClient
      role={session.role}
      username={session.username}
      team={session.team}
    />
  );
}