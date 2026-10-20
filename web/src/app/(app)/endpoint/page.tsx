import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import EndpointClient from "./EndpointClient";

export default async function EndpointPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const base = (process.env.ROUTER_PUBLIC_URL || process.env.ROUTER_URL || "http://localhost:8080").replace(/\/$/, "");
  return (
    <EndpointClient
      role={session.role}
      team={session.team}
      username={session.username}
      baseUrl={base}
    />
  );
}