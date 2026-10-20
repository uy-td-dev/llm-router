"use client";

import { useState } from "react";
import { Activity, AlertTriangle, BarChart3, Coins, Database, PiggyBank, Zap } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Empty, PageHeader, Panel, Segmented, Select, Stat, fmt, useJson } from "@/components/ui";
import Monitor from "./Monitor";

interface Hour {
  hour: number;
  requests: number;
  errors: number;
  cache_hits: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  saved_tokens: number;
}
interface Group {
  name: string;
  requests: number;
  errors: number;
  tokens: number;
  cost_usd: number;
  avg_latency_ms: number;
}
interface Report {
  hours: number;
  series: Hour[];
  totals: Hour;
  by_provider: Group[];
  by_model: Group[];
  by_account: Group[];
  by_key: Group[];
}
interface Req {
  id: number;
  ts: string;
  key: string;
  requested_model: string;
  provider: string;
  model: string;
  account: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  latency_ms: number;
  status: string;
  error?: string;
}

const COLORS = ["#34d399", "#22d3ee", "#a78bfa", "#fbbf24", "#fb7185", "#60a5fa", "#f472b6", "#4ade80"];
const RANGES = [
  [1, "1h"],
  [6, "6h"],
  [24, "24h"],
  [72, "3d"],
  [168, "7d"],
] as const;

const TABS = [
  ["by_model", "Model"],
  ["by_provider", "Provider"],
  ["by_account", "Account"],
  ["by_key", "API key"],
] as const;

const STATUSES = [
  ["", "Tất cả"],
  ["ok", "Thành công"],
  ["error", "Lỗi"],
  ["cache", "Cache"],
] as const;

const tooltipStyle = {
  contentStyle: {
    background: "rgba(9,9,11,0.95)",
    border: "1px solid #27272a",
    borderRadius: 14,
    fontSize: 11,
    backdropFilter: "blur(8px)",
    boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
  },
  labelStyle: { color: "#a1a1aa", fontWeight: 600 },
  itemStyle: { fontSize: 11 },
  cursor: { fill: "rgba(255,255,255,0.03)" },
};

export default function UsagePage() {
  const [hours, setHours] = useState(24);
  const [tab, setTab] = useState<"by_provider" | "by_model" | "by_account" | "by_key">("by_model");
  const [status, setStatus] = useState("");
  const { data } = useJson<Report>(`/admin/usage?hours=${hours}`, 10000);
  const reqs = useJson<{ rows: Req[] }>(`/admin/requests?limit=100${status ? `&status=${status}` : ""}`, 10000);

  const series = (data?.series ?? []).map((h) => ({
    ...h,
    label: new Date(h.hour * 1000).toLocaleString("vi-VN", hours > 24 ? { day: "2-digit", month: "2-digit", hour: "2-digit" } : { hour: "2-digit", minute: "2-digit" }),
    tokens: h.prompt_tokens + h.completion_tokens,
  }));
  const t = data?.totals;
  const groups = data?.[tab] ?? [];
  const okRate = t && t.requests + t.errors > 0 ? (t.requests / (t.requests + t.errors)) * 100 : 100;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={BarChart3}
        title="Usage"
        desc="Lưu lượng, token và chi phí theo giờ (lưu trong bộ nhớ, giữ 7 ngày gần nhất). Lịch sử dài hạn nằm ở Dashboard nếu đã bật persistence."
        actions={<Segmented value={hours} options={RANGES} onChange={setHours} />}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Requests" value={fmt.n(t?.requests ?? 0)} icon={Activity} sub={`${okRate.toFixed(1)}% thành công`} />
        <Stat label="Lỗi" value={fmt.n(t?.errors ?? 0)} icon={AlertTriangle} tone="rose" />
        <Stat label="Tokens" value={fmt.k((t?.prompt_tokens ?? 0) + (t?.completion_tokens ?? 0))} icon={Zap} tone="cyan" sub={`in ${fmt.k(t?.prompt_tokens ?? 0)} · out ${fmt.k(t?.completion_tokens ?? 0)}`} />
        <Stat label="Chi phí" value={fmt.usd(t?.cost_usd ?? 0)} icon={Coins} tone="amber" />
        <Stat label="Cache / Saved" value={fmt.n(t?.cache_hits ?? 0)} icon={PiggyBank} tone="violet" sub={`${fmt.k(t?.saved_tokens ?? 0)} token tiết kiệm`} />
      </div>

      {/* Admin-only: who (team/user/key) used what (model/provider/account). */}
      <Monitor />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Requests theo thời gian" className="lg:col-span-2">
          <div className="h-64">
            <ResponsiveContainer>
              <AreaChart data={series} margin={{ left: -20, right: 8, top: 4 }}>
                <defs>
                  <linearGradient id="gReq" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#34d399" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gErr" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#fb7185" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#fb7185" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: "#71717a", fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tick={{ fill: "#71717a", fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip {...tooltipStyle} />
                <Area type="monotone" dataKey="requests" name="requests" stroke="#34d399" fill="url(#gReq)" strokeWidth={2} />
                <Area type="monotone" dataKey="errors" name="errors" stroke="#fb7185" fill="url(#gErr)" strokeWidth={1.5} />
                <Area type="monotone" dataKey="cache_hits" name="cache" stroke="#a78bfa" fill="transparent" strokeWidth={1.5} strokeDasharray="4 3" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Phân bổ theo provider">
          {data?.by_provider.length ? (
            <div className="h-64">
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={data.by_provider} dataKey="requests" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={3} stroke="none">
                    {data.by_provider.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip {...tooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
              <div className="-mt-4 flex flex-wrap justify-center gap-x-3 gap-y-1">
                {data.by_provider.map((g, i) => (
                  <span key={g.name} className="flex items-center gap-1 text-[10px] text-zinc-400">
                    <span className="h-2 w-2 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                    {g.name}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <Empty icon={Database}>Chưa có dữ liệu</Empty>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Tokens theo thời gian">
          <div className="h-56">
            <ResponsiveContainer>
              <BarChart data={series} margin={{ left: -10, right: 8, top: 4 }}>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: "#71717a", fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tick={{ fill: "#71717a", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={fmt.k} />
                <Tooltip {...tooltipStyle} cursor={{ fill: "#ffffff08" }} />
                <Bar dataKey="prompt_tokens" name="input" stackId="t" fill="#22d3ee" radius={[0, 0, 0, 0]} />
                <Bar dataKey="completion_tokens" name="output" stackId="t" fill="#34d399" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="Chi phí theo thời gian">
          <div className="h-56">
            <ResponsiveContainer>
              <AreaChart data={series} margin={{ left: -4, right: 8, top: 4 }}>
                <defs>
                  <linearGradient id="gCost" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#fbbf24" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#fbbf24" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: "#71717a", fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tick={{ fill: "#71717a", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${Number(v).toFixed(3)}`} />
                <Tooltip {...tooltipStyle} formatter={(v) => fmt.usd(Number(v))} />
                <Area type="monotone" dataKey="cost_usd" name="cost" stroke="#fbbf24" fill="url(#gCost)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <Panel
        title="Chi tiết"
        actions={<Segmented value={tab} options={TABS} onChange={setTab} />}
      >
        {groups.length ? (
          <table className="w-full text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-zinc-500">
              <tr className="border-b border-zinc-800">
                <th className="pb-2 font-medium">Tên</th>
                <th className="pb-2 text-right font-medium">Requests</th>
                <th className="pb-2 text-right font-medium">Lỗi</th>
                <th className="pb-2 text-right font-medium">Tokens</th>
                <th className="pb-2 text-right font-medium">Chi phí</th>
                <th className="pb-2 text-right font-medium">Latency TB</th>
                <th className="w-1/4 pb-2" />
              </tr>
            </thead>
            <tbody>
              {groups.map((g, i) => {
                const max = Math.max(...groups.map((x) => x.requests), 1);
                return (
                  <tr key={g.name} className="border-b border-zinc-800/50 last:border-0">
                    <td className="py-2 font-mono text-zinc-200">{g.name}</td>
                    <td className="py-2 text-right tabular-nums">{fmt.n(g.requests)}</td>
                    <td className={`py-2 text-right tabular-nums ${g.errors ? "text-rose-400" : "text-zinc-600"}`}>{g.errors}</td>
                    <td className="py-2 text-right tabular-nums text-zinc-400">{fmt.k(g.tokens)}</td>
                    <td className="py-2 text-right tabular-nums text-amber-300/90">{fmt.usd(g.cost_usd)}</td>
                    <td className="py-2 text-right tabular-nums text-zinc-400">{g.avg_latency_ms ? `${Math.round(g.avg_latency_ms)}ms` : "—"}</td>
                    <td className="py-2 pl-4">
                      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                        <div className="h-full rounded-full" style={{ width: `${(g.requests / max) * 100}%`, background: COLORS[i % COLORS.length] }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty icon={Database}>Chưa có request nào trong khoảng thời gian này</Empty>
        )}
      </Panel>

      <Panel
        title="Request log"
        actions={
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </Select>
        }
      >
        {reqs.error ? (
          <p className="text-xs text-zinc-500">Chỉ admin xem được request log.</p>
        ) : reqs.data?.rows.length ? (
          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-zinc-900/95 text-[10px] uppercase tracking-wider text-zinc-500 backdrop-blur-sm">
                <tr>
                  <th className="py-2 font-medium">Thời gian</th>
                  <th className="py-2 font-medium">Trạng thái</th>
                  <th className="py-2 font-medium">Key</th>
                  <th className="py-2 font-medium">Model yêu cầu</th>
                  <th className="py-2 font-medium">Phục vụ bởi</th>
                  <th className="py-2 text-right font-medium">Tokens</th>
                  <th className="py-2 text-right font-medium">Chi phí</th>
                  <th className="py-2 text-right font-medium">Latency</th>
                </tr>
              </thead>
              <tbody>
                {reqs.data.rows.map((r) => (
                  <tr key={r.id} className="border-t border-zinc-800/50 align-top">
                    <td className="py-1.5 tabular-nums text-zinc-500">{fmt.time(r.ts)}</td>
                    <td className="py-1.5">
                      <Badge tone={r.status === "ok" ? "emerald" : r.status === "cache" ? "violet" : "rose"}>{r.status}</Badge>
                    </td>
                    <td className="py-1.5 text-zinc-400">{r.key}</td>
                    <td className="py-1.5 font-mono text-zinc-300">{r.requested_model}</td>
                    <td className="py-1.5 font-mono text-zinc-400">
                      {r.error ? (
                        <span className="text-rose-300/80" title={r.error}>
                          {r.error.slice(0, 80)}
                          {r.error.length > 80 && "…"}
                        </span>
                      ) : (
                        <>
                          {r.provider}/{r.model}
                          {r.account && <span className="text-zinc-600"> · {r.account}</span>}
                        </>
                      )}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-400">{r.prompt_tokens + r.completion_tokens || "—"}</td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-400">{r.cost_usd ? fmt.usd(r.cost_usd) : "—"}</td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-400">{r.latency_ms ? `${r.latency_ms}ms` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={Activity}>Chưa có request</Empty>
        )}
      </Panel>
    </div>
  );
}
