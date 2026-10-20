import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import Sidebar from "@/components/Sidebar";
import pkg from "../../../package.json";

// Session-protected area: allow blocking render (cookies-based auth).
export const instant = false;

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  return (
    <div className="noise-bg relative min-h-screen bg-zinc-950 text-zinc-100">
      {/* Ambient background gradients */}
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute -left-32 -top-32 h-[500px] w-[500px] rounded-full bg-emerald-500/[0.04] blur-[120px]" />
        <div className="absolute -bottom-48 -right-48 h-[600px] w-[600px] rounded-full bg-cyan-500/[0.03] blur-[140px]" />
        <div className="absolute left-1/2 top-1/3 h-[400px] w-[400px] -translate-x-1/2 rounded-full bg-violet-500/[0.02] blur-[100px]" />
      </div>

      <Sidebar
        role={session.role}
        user={session.displayName}
        team={session.team}
        version={pkg.version}
      />

      <main className="relative z-10 px-4 py-6 transition-all lg:ml-64 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-7xl animate-fade-in">{children}</div>
      </main>
    </div>
  );
}
