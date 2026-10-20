import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import ConsoleClient from "./ConsoleClient";

export default async function ConsolePage() {
  const session = await getSession();
  if (session?.role !== "admin") redirect("/dash");
  return <ConsoleClient />;
}
