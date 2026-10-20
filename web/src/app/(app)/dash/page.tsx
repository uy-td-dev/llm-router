"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Coins,
  Database,
  Gauge,
  KeyRound,
  PiggyBank,
  Server,
  Timer,
  Zap,
} from "lucide-react";
import { Badge, Btn, Empty, Meter, PageHeader, Panel, Select, fmt, inputCls } from "@/components/ui";

interface Stats {
  uptime_seconds: number;
  total_requests: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cost_usd: number;
  cache_hits: number;
  semantic_cache_hits: number;
  breakdown: {
    provider: string;
    model: string;
    requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    cost_usd: number;
  }[];
  by_api_key: {
    api_key: string;
    owner: string;
    requests: number;
    cost_usd: number;
  }[];
}

interface HistoryResponse {
  mode: string;
  group: string;
  rows: Record<string, unknown>[];
  note?: string;
  error?: string;
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: "#34d399",
  anthropic: "#a78bfa",
  google: "#60a5fa",
  "github-copilot": "#22d3ee",
  azure: "#fbbf24",
};

function providerColor(name: string): string {
  return PROVIDER_COLORS[name] ?? "#f472b6";
}

export default function DashPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [minutes, setMinutes] = useState(1440);
  const [group, setGroup] = useState("day");
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/proxy/admin/stats");
      if (res.ok) {
        setStats(await res.json());
        setError(null);
      } else {
        setError("Không tải được /admin/stats (llm-router chạy chưa?)");
      }
    } catch {
      setError("Không kết nối được tới llm-router");
    }
  }, []);

  const loadHistory = useCallback(async () => {
    const res = await fetch(`/api/proxy/admin/history?group=${group}&minutes=${minutes}`);
    if (res.ok) setHistory(await res.json());
  }, [group, minutes]);

  useEffect(() => {
    load();
    if (!live) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load, live]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const uptime = stats
    ? `${Math.floor(stats.uptime_seconds / 3600)}h ${Math.floor((stats.uptime_seconds % 3600) / 60)}m`
    : "—";

  const totalTokens = (stats?.total_prompt_tokens ?? 0) + (stats?.total_completion_tokens ?? 0);
  const maxCost = stats ? Math.max(...stats.breakdown.map((b) => b.cost_usd), 1e-9) : 1;
  const maxReq = stats ? Math.max(...stats.breakdown.map((b) => b.requests), 1) : 1;
  const maxHistoryCost = history?.rows
    ? Math.max(...history.rows.map((r) => Number(r.cost_usd ?? 0)), 1e-9)
    : 1;
  const maxKeyCost = stats?.by_api_key.length
    ? Math.max(...stats.by_api_key.map((k) => k.cost_usd), 1e-9)
    : 1;

  const breakdown = useMemo(() => stats?.breakdown ?? [], [stats]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Gauge}
        title="Dashboard"
        desc="Tổng quan hoạt động của router: lưu lượng, token, chi phí và lịch sử sử dụng theo thời gian thực."
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={live ? "emerald" : "zinc"}>
              <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-400 animate-pulse" : "bg-zinc-500"}`} />
              {live ? "Live" : "Paused"}
            </Badge>
            <Btn variant={live ? "ghost" : "subtle"} size="sm" onClick={() => setLive((v) => !v)}>
              <Activity size={13} />
              {live ? "Tạm dừng" : "Tiếp tục"}
            </Btn>
            <Btn variant="ghost" size="sm" onClick={load}>
              Refresh
            </Btn>
          </div>
        }
      />

      {error && (
        <div className="flex items-center gap-2.5 rounded-2xl border border-amber-500/25 bg-amber-950/20 px-4 py-3 text-[13px] text-amber-300">
          <AlertTriangle size={15} className="shrink-0" />
          {error}
        </div>
      )}

      {/* Stats Grid */}
      <div className="stagger-children grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <StatCard
          label="Requests"
          value={fmt.n(stats?.total_requests ?? 0)}
          sub="Từ khi khởi động"
          icon={<Activity size={16} />}
          tone="emerald"
        />
        <StatCard
          label="Tokens"
          value={fmt.k(totalTokens)}
          sub={`in ${fmt.k(stats?.total_prompt_tokens ?? 0)} · out ${fmt.k(stats?.total_completion_tokens ?? 0)}`}
          icon={<Zap size={16} />}
          tone="cyan"
        />
        <StatCard
          label="Chi phí"
          value={fmt.usd(stats?.total_cost_usd ?? 0)}
          sub="Kể từ khi start"
          icon={<Coins size={16} />}
          tone="amber"
        />
        <StatCard
          label="Uptime"
          value={uptime}
          sub={`cache ${fmt.n(stats?.cache_hits ?? 0)} · semantic ${fmt.n(stats?.semantic_cache_hits ?? 0)}`}
          icon={<Timer size={16} />}
          tone="violet"
        />
      </div>

      {/* Breakdown */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Chi tiêu theo provider/model" icon={Coins}>
          {breakdown.length ? (
            <div className="space-y-4">
              {breakdown.map((b) => (
                <div key={`${b.provider}/${b.model}`} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-2 text-zinc-300">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: providerColor(b.provider) }}
                      />
                      <span className="font-medium">{b.provider}</span>
                      <span className="text-zinc-600">/</span>
                      <span className="font-mono text-zinc-400">{b.model}</span>
                    </span>
                    <span className="tabular-nums text-zinc-500">
                      <span className="text-amber-300/90">${b.cost_usd.toFixed(6)}</span>
                      <span className="mx-1.5 text-zinc-700">·</span>
                      {fmt.n(b.requests)} req
                    </span>
                  </div>
                  <div className="relative">
                    <Meter value={(b.cost_usd / maxCost) * 100} tone="amber" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty icon={Coins}>Chưa có usage nào.</Empty>
          )}
        </Panel>

        <Panel title="Requests theo provider/model" icon={Activity}>
          {breakdown.length ? (
            <div className="space-y-4">
              {breakdown.map((b) => (
                <div key={`r-${b.provider}/${b.model}`} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-2 text-zinc-300">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: providerColor(b.provider) }}
                      />
                      <span className="font-medium">{b.provider}</span>
                      <span className="text-zinc-600">/</span>
                      <span className="font-mono text-zinc-400">{b.model}</span>
                    </span>
                    <span className="tabular-nums text-zinc-400">{fmt.n(b.requests)} req</span>
                  </div>
                  <Meter value={(b.requests / maxReq) * 100} tone="emerald" />
                </div>
              ))}
            </div>
          ) : (
            <Empty icon={Activity}>Chưa có request nào.</Empty>
          )}
        </Panel>
      </div>

      {/* History */}
      <Panel
        title="Lịch sử usage"
        icon={Database}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="day">Theo ngày</option>
              <option value="key">Theo API key</option>
              <option value="provider">Theo provider</option>
              <option value="model">Theo model</option>
              <option value="raw">Raw records</option>
            </Select>
            <Select value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))}>
              <option value={60}>1 giờ</option>
              <option value={1440}>24 giờ</option>
              <option value={10080}>7 ngày</option>
              <option value={43200}>30 ngày</option>
            </Select>
            <a
              href={`/api/history/export?group=${group}&minutes=${minutes}`}
              download
              className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-700/70 bg-zinc-900/40 px-3.5 py-1.5 text-xs font-medium text-zinc-300 transition-all duration-200 hover:border-zinc-600 hover:bg-zinc-800/70 hover:text-zinc-100"
            >
              Xuất CSV
            </a>
          </div>
        }
      >
        {history?.note && (
          <p className="mb-3 flex items-center gap-2 text-xs text-amber-400">
            <AlertTriangle size={13} />
            {history.note}
          </p>
        )}

        {history?.rows?.length ? (
          group === "raw" ? (
            <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
              <table className="w-full text-left text-xs">
                <thead className="bg-zinc-900/80 text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-3 py-2.5 font-medium">Thời gian</th>
                    <th className="px-3 py-2.5 font-medium">Key</th>
                    <th className="px-3 py-2.5 font-medium">Provider</th>
                    <th className="px-3 py-2.5 font-medium">Model</th>
                    <th className="px-3 py-2.5 text-right font-medium">Tokens</th>
                    <th className="px-3 py-2.5 text-right font-medium">Chi phí</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-zinc-400">
                  {history.rows.slice(0, 30).map((r: Record<string, unknown>, i: number) => (
                    <tr key={i} className="border-t border-zinc-800/40 transition-colors hover:bg-zinc-800/20">
                      <td className="px-3 py-2 tabular-nums">
                        {String(r.ts ?? "").slice(0, 19).replace("T", " ")}
                      </td>
                      <td className="px-3 py-2 text-emerald-300/80">{String(r.api_key ?? "")}</td>
                      <td className="px-3 py-2">{String(r.provider ?? "")}</td>
                      <td className="px-3 py-2">{String(r.model ?? "")}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{String(r.total_tokens ?? "")}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-amber-300/80">
                        ${Number(r.cost_usd ?? 0).toFixed(6)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="space-y-4">
              {history.rows.map((r: Record<string, unknown>, i: number) => (
                <div key={i} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-zinc-300">
                      {String(r.bucket ?? r.api_key ?? r.provider ?? r.model ?? "")}
                    </span>
                    <span className="tabular-nums text-zinc-500">
                      ${Number(r.cost_usd ?? 0).toFixed(6)}
                    </span>
                  </div>
                  <Meter value={(Number(r.cost_usd ?? 0) / maxHistoryCost) * 100} tone="cyan" />
                </div>
              ))}
            </div>
          )
        ) : (
          <Empty icon={Database}>
            Không có dữ liệu (bật database.mode: sqlite để lưu lịch sử).
          </Empty>
        )}
      </Panel>

      {/* By key */}
      <Panel title="Theo virtual key / owner" icon={KeyRound}>
        {stats?.by_api_key.length ? (
          <div className="space-y-4">
            {stats.by_api_key.map((k) => (
              <div key={k.api_key} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-emerald-300/90">{k.api_key}</span>
                    <Badge tone="zinc">{k.owner}</Badge>
                  </span>
                  <span className="tabular-nums text-zinc-500">
                    {fmt.n(k.requests)} req · <span className="text-amber-300/90">${k.cost_usd.toFixed(4)}</span>
                  </span>
                </div>
                <Meter value={(k.cost_usd / maxKeyCost) * 100} tone="violet" />
              </div>
            ))}
          </div>
        ) : (
          <Empty icon={KeyRound}>Chưa có request nào qua key.</Empty>
        )}
      </Panel>

      {/* Cache stats mini panel */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Panel className="!p-4">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-violet-500/10 text-violet-300">
              <PiggyBank size={18} />
            </span>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Cache hits</div>
              <div className="text-lg font-bold tabular-nums text-zinc-50">{fmt.n(stats?.cache_hits ?? 0)}</div>
            </div>
          </div>
        </Panel>
        <Panel className="!p-4">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-500/10 text-cyan-300">
              <Database size={18} />
            </span>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Semantic cache</div>
              <div className="text-lg font-bold tabular-nums text-zinc-50">{fmt.n(stats?.semantic_cache_hits ?? 0)}</div>
            </div>
          </div>
        </Panel>
        <Panel className="!p-4 sm:col-span-2 lg:col-span-1">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-500/10 text-emerald-300">
              <Server size={18} />
            </span>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Providers</div>
              <div className="text-lg font-bold tabular-nums text-zinc-50">
                {new Set(breakdown.map((b) => b.provider)).size}
              </div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  icon,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  tone: "emerald" | "cyan" | "amber" | "violet";
}) {
  const tones = {
    emerald: { grad: "from-emerald-500/20", text: "text-emerald-300", bg: "bg-emerald-500/10" },
    cyan: { grad: "from-cyan-500/20", text: "text-cyan-300", bg: "bg-cyan-500/10" },
    amber: { grad: "from-amber-500/20", text: "text-amber-300", bg: "bg-amber-500/10" },
    violet: { grad: "from-violet-500/20", text: "text-violet-300", bg: "bg-violet-500/10" },
  }[tone];

  return (
    <div className="group relative animate-fade-in overflow-hidden rounded-2xl border border-zinc-800/70 bg-zinc-900/40 p-4 transition-all duration-300 hover:-translate-y-0.5 hover:bg-zinc-900/70 hover:shadow-xl hover:shadow-black/30">
      <div
        className={`pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full bg-gradient-to-br ${tones.grad} to-transparent opacity-60 blur-2xl transition-opacity duration-500 group-hover:opacity-100`}
      />
      <div className="relative flex items-center justify-between gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-zinc-500">{label}</span>
        <span
          className={`grid h-7 w-7 place-items-center rounded-lg ${tones.bg} ${tones.text} transition-transform duration-300 group-hover:scale-110`}
        >
          {icon}
        </span>
      </div>
      <div className="relative mt-2 text-[26px] font-bold leading-none tabular-nums tracking-tight text-zinc-50">
        {value}
      </div>
      {sub && <div className="relative mt-1.5 text-[11px] leading-snug text-zinc-500">{sub}</div>}
    </div>
  );
}
