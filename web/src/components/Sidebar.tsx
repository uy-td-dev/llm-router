"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BarChart3,
  Bot,
  Cable,
  ChevronDown,
  Database,
  Gauge,
  KeyRound,
  Layers,
  LayoutDashboard,
  LogOut,
  Menu,
  Network,
  PiggyBank,
  Plug,
  Puzzle,
  ScrollText,
  Search,
  Server,
  Settings2,
  SquareTerminal,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

type Item = { href: string; label: string; icon: LucideIcon; roles?: Role[] };

// Visibility per role. Anything not listed defaults to admin-only so new
// pages never leak to scoped roles by accident.
type Role = "admin" | "team_lead" | "user";

const ALL: Role[] = ["admin", "team_lead", "user"];
const STAFF: Role[] = ["admin", "team_lead"];

const GROUPS: { title?: string; items: Item[] }[] = [
  {
    items: [
      { href: "/dash", label: "Dashboard", icon: LayoutDashboard, roles: ["admin"] },
      { href: "/endpoint", label: "Endpoint & Key", icon: KeyRound, roles: ALL },
      { href: "/providers", label: "Providers", icon: Server, roles: STAFF },
      { href: "/combos", label: "Combo & Vision", icon: Layers, roles: ["admin"] },
      { href: "/usage", label: "Usage Analytics", icon: BarChart3, roles: ["admin", "team_lead", "user"] },
      { href: "/quota", label: "Quota Tracker", icon: Gauge, roles: ["admin"] },
      { href: "/token-saver", label: "Token Saver", icon: PiggyBank, roles: ["admin"] },
      { href: "/cli-tools", label: "CLI Tools", icon: SquareTerminal, roles: ["admin"] },
    ],
  },
  {
    title: "System",
    items: [
      { href: "/proxy-pools", label: "Proxy Pools", icon: Network, roles: ["admin"] },
      { href: "/skills", label: "Skills", icon: Puzzle, roles: ["admin"] },
      { href: "/console", label: "Console Log", icon: ScrollText, roles: ["admin"] },
      { href: "/system", label: "System", icon: Cable, roles: ["admin"] },
      { href: "/config", label: "Config YAML", icon: Settings2, roles: ["admin"] },
      { href: "/teams", label: "Teams & Users", icon: Users, roles: STAFF },
    ],
  },
  {
    title: "Tools",
    items: [
      { href: "/chat", label: "Chat Playground", icon: Bot, roles: ["admin"] },
      { href: "/mcp", label: "MCP Servers", icon: Plug, roles: ["admin"] },
    ],
  },
];

export default function Sidebar({
  role,
  user,
  team,
  version,
}: {
  role: string;
  user: string;
  team?: string | null;
  version: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [online, setOnline] = useState<boolean | null>(null);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [search, setSearch] = useState("");

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    let alive = true;
    const ping = () =>
      fetch("/api/proxy/health")
        .then((r) => alive && setOnline(r.ok))
        .catch(() => alive && setOnline(false));
    ping();
    const id = setInterval(ping, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const toggleGroup = (i: number) => setCollapsed((p) => ({ ...p, [i]: !p[i] }));

  const filteredGroups = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((item) => {
      const allowed = item.roles ?? ["admin"];
      if (!allowed.includes(role as Role)) return false;
      if (!search) return true;
      return item.label.toLowerCase().includes(search.toLowerCase());
    }),
  })).filter((g) => g.items.length > 0);

  const nav = (
    <div className="flex h-full flex-col">
      {/* Logo Area */}
      <div className="relative px-4 pb-3 pt-5">
        <div className="flex items-center gap-3">
          <div className="relative grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-emerald-400 via-teal-400 to-cyan-500 shadow-lg shadow-emerald-500/25 transition-all duration-300 hover:shadow-emerald-500/40">
            <Database size={20} strokeWidth={2.2} className="text-zinc-950" />
            <div className="absolute inset-0 rounded-xl bg-white/20 opacity-0 transition-opacity hover:opacity-100" />
          </div>
          <div className="leading-tight">
            <div className="text-[15px] font-bold tracking-tight text-zinc-50">LLM Router</div>
            <div className="flex items-center gap-2 text-[10px] text-zinc-500">
              <span className="font-mono">v{version}</span>
              <span className="flex items-center gap-1">
                <span
                  className={`h-1.5 w-1.5 rounded-full transition-colors duration-500 ${
                    online === null ? "bg-zinc-600" : online ? "bg-emerald-400 animate-pulse-glow" : "bg-rose-500"
                  }`}
                />
                <span className={online ? "text-emerald-400/80" : online === false ? "text-rose-400/80" : ""}>
                  {online === null ? "checking…" : online ? "online" : "offline"}
                </span>
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm menu…"
            className="w-full rounded-lg border border-zinc-800/80 bg-zinc-900/50 py-1.5 pl-8 pr-3 text-[11px] text-zinc-200 placeholder:text-zinc-600 outline-none transition-all focus:border-emerald-500/40 focus:bg-zinc-900/80 focus:ring-1 focus:ring-emerald-500/20"
          />
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-4">
        {filteredGroups.map((g, gi) => {
          const isCollapsed = collapsed[gi] && !search;
          return (
            <div key={gi} className="animate-slide-in" style={{ animationDelay: `${gi * 60}ms` }}>
              {g.title && (
                <button
                  onClick={() => toggleGroup(gi)}
                  className="group flex w-full items-center justify-between px-3 py-2 text-left"
                >
                  <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-600 transition-colors group-hover:text-zinc-400">
                    {g.title}
                  </span>
                  <ChevronDown
                    size={12}
                    className={`text-zinc-700 transition-transform duration-200 ${isCollapsed ? "-rotate-90" : ""}`}
                  />
                </button>
              )}
              {!isCollapsed && (
                <ul className="space-y-0.5">
                  {g.items.map(({ href, label, icon: Icon }) => {
                    const active = pathname === href || pathname.startsWith(href + "/");
                    return (
                      <li key={href}>
                        <Link
                          href={href}
                          className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-all duration-200 ${
                            active
                              ? "bg-gradient-to-r from-emerald-500/15 via-emerald-500/8 to-transparent text-zinc-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                              : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-100 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
                          }`}
                        >
                          {active && (
                            <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-gradient-to-b from-emerald-400 to-teal-500 shadow-[0_0_8px_rgba(52,211,153,0.5)]" />
                          )}
                          <Icon
                            size={17}
                            strokeWidth={active ? 2.2 : 1.8}
                            className={`transition-colors duration-200 ${
                              active ? "text-emerald-400 drop-shadow-[0_0_6px_rgba(52,211,153,0.4)]" : "text-zinc-500 group-hover:text-zinc-300"
                            }`}
                          />
                          <span className="truncate">{label}</span>
                          {active && (
                            <span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </nav>

      {/* User Profile */}
      <div className="border-t border-zinc-800/60 p-3">
        <div className="group flex items-center gap-3 rounded-xl border border-transparent px-2 py-2 transition-all hover:border-zinc-800/50 hover:bg-zinc-900/50">
          <div className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-zinc-700 to-zinc-800 text-xs font-bold uppercase text-zinc-200 shadow-inner ring-2 ring-zinc-900">
            {user.slice(0, 2)}
            <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-zinc-950 bg-emerald-500" />
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[13px] font-semibold text-zinc-100">{user}</div>
            <div className="flex items-center gap-1.5 text-[10px] font-medium text-zinc-500">
              <span className="capitalize">{role === "team_lead" ? "Team Lead" : role}</span>
              {team && (
                <span className="rounded bg-emerald-500/10 px-1.5 py-px text-emerald-400/90">{team}</span>
              )}
            </div>
          </div>
          <button
            onClick={logout}
            title="Đăng xuất"
            className="rounded-lg p-2 text-zinc-500 transition-all hover:bg-rose-500/10 hover:text-rose-400"
          >
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-zinc-800/60 bg-zinc-950/95 backdrop-blur-xl lg:block">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(16,185,129,0.06),transparent_60%)]" />
        <div className="relative h-full">{nav}</div>
      </aside>

      {/* Mobile Header */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-zinc-800/60 bg-zinc-950/90 px-4 py-3 backdrop-blur-xl lg:hidden">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-emerald-400 to-cyan-500 text-zinc-950">
            <Database size={16} strokeWidth={2.5} />
          </div>
          <span className="text-sm font-bold tracking-tight">LLM Router</span>
        </div>
        <button onClick={() => setOpen(true)} className="rounded-lg p-2 text-zinc-300 transition hover:bg-zinc-800">
          <Menu size={20} />
        </button>
      </div>

      {/* Mobile Drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity" />
          <aside
            className="absolute inset-y-0 left-0 w-72 border-r border-zinc-800/60 bg-zinc-950 shadow-2xl shadow-black/50"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setOpen(false)}
              className="absolute right-3 top-4 rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
            >
              <X size={18} />
            </button>
            {nav}
          </aside>
        </div>
      )}
    </>
  );
}
