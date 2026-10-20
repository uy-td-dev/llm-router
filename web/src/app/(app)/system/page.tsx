"use client";

import Link from "next/link";
import { Activity, Cable, Cpu, Database, Eye, Gauge, HardDrive, KeyRound, Layers, Network, PiggyBank, Puzzle, Server, Timer, Users } from "lucide-react";
import { Badge, PageHeader, Panel, Stat, fmt, useJson } from "@/components/ui";

interface Sys {
  version: string;
  started_at: string;
  uptime_seconds: number;
  os: string;
  arch: string;
  pid: number;
  providers: number;
  models: number;
  accounts: number;
  combos: number;
  keys: number;
  cache: boolean;
  semantic_cache: boolean;
  persistence: { mode: string; usage_records: number; keys: number };
  features: { token_saver: boolean; vision: boolean; proxies: number; skills: number; quotas: number };
}

export default function SystemPage() {
  const { data, error } = useJson<Sys>("/admin/system", 5000);
  const health = useJson<unknown>("/health", 5000);

  const features = data
    ? [
        { href: "/token-saver", icon: PiggyBank, label: "Token Saver", on: data.features.token_saver, v: data.features.token_saver ? "bật" : "tắt" },
        { href: "/combos", icon: Eye, label: "Vision Adapter", on: data.features.vision, v: data.features.vision ? "bật" : "tắt" },
        { href: "/proxy-pools", icon: Network, label: "Proxy Pools", on: data.features.proxies > 0, v: `${data.features.proxies} proxy` },
        { href: "/skills", icon: Puzzle, label: "Skills", on: data.features.skills > 0, v: `${data.features.skills} đang bật` },
        { href: "/quota", icon: Gauge, label: "Quota", on: data.features.quotas > 0, v: `${data.features.quotas} giới hạn` },
        { href: "/config", icon: Database, label: "Response cache", on: data.cache, v: data.cache ? "bật" : "tắt" },
        { href: "/config", icon: Layers, label: "Semantic cache", on: data.semantic_cache, v: data.semantic_cache ? "bật" : "tắt" },
      ]
    : [];

  return (
    <div className="space-y-6">
      <PageHeader icon={Cable} title="System" desc="Trạng thái của router và các tính năng đang hoạt động." />

      {error && (
        <p className="flex items-center gap-2 rounded-xl border border-rose-500/25 bg-rose-950/20 px-4 py-3 text-xs text-rose-300 animate-fade-in">
          Không lấy được trạng thái: {error}
        </p>
      )}

      <div className="stagger-children grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <Stat
          label="Router"
          value={<span className={health.error ? "text-rose-400" : "text-emerald-400"}>{health.error ? "Offline" : "Online"}</span>}
          icon={Activity}
          sub={data ? `v${data.version} · pid ${data.pid}` : undefined}
        />
        <Stat label="Uptime" value={fmt.dur(data?.uptime_seconds ?? 0)} icon={Timer} tone="cyan" sub={data ? new Date(data.started_at).toLocaleString("vi-VN") : undefined} />
        <Stat label="Platform" value={data ? `${data.os}` : "—"} icon={Cpu} tone="violet" sub={data?.arch} />
        <Stat label="Persistence" value={data?.persistence.mode ?? "—"} icon={HardDrive} tone="amber" sub={data ? `${fmt.n(data.persistence.usage_records)} bản ghi` : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Tài nguyên" icon={Server}>
          <div className="grid grid-cols-2 gap-2.5">
            {[
              [Server, "Providers", data?.providers, "/providers"],
              [Layers, "Models", data?.models, "/endpoint"],
              [Users, "Tài khoản upstream", data?.accounts, "/quota"],
              [Layers, "Combos", data?.combos, "/combos"],
              [KeyRound, "Virtual keys", data?.keys, "/endpoint"],
            ].map(([Icon, label, v, href]) => {
              const I = Icon as typeof Server;
              return (
                <Link
                  key={label as string}
                  href={href as string}
                  className="group flex items-center gap-3 rounded-xl border border-zinc-800/70 bg-zinc-900/40 px-3.5 py-3 transition-all hover:border-emerald-500/30 hover:bg-zinc-900/70"
                >
                  <I size={15} className="text-zinc-500 transition-colors group-hover:text-emerald-400" />
                  <span className="flex-1 text-xs text-zinc-400">{label as string}</span>
                  <span className="text-sm font-bold tabular-nums text-zinc-100">{(v as number) ?? "—"}</span>
                </Link>
              );
            })}
          </div>
        </Panel>

        <Panel title="Tính năng" icon={Gauge}>
          <div className="space-y-2">
            {features.map((f) => (
              <Link
                key={f.label}
                href={f.href}
                className="group flex items-center gap-3 rounded-xl border border-zinc-800/70 bg-zinc-900/40 px-3.5 py-2.5 transition-all hover:border-zinc-700"
              >
                <f.icon size={15} className={f.on ? "text-emerald-400" : "text-zinc-600"} />
                <span className="flex-1 text-xs text-zinc-300">{f.label}</span>
                <Badge tone={f.on ? "emerald" : "zinc"}>{f.v}</Badge>
              </Link>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
