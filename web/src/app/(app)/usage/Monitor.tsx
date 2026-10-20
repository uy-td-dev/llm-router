"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Database, KeyRound, Users, UsersRound } from "lucide-react";
import { Badge, Empty, Panel, Segmented, fmt, useJson } from "@/components/ui";

// ---- shapes returned by /admin/insights ----
interface Grp {
  name: string;
  requests: number;
  errors: number;
  tokens: number;
  cost_usd: number;
}
interface Node {
  name: string;
  owner?: string;
  team?: string | null;
  requests: number;
  errors: number;
  tokens: number;
  cost_usd: number;
  by_model?: Grp[];
  by_provider?: Grp[];
  by_account?: Grp[];
  by_key?: Grp[];
  by_owner?: Grp[];
}
interface Insights {
  hours: number;
  totals: { requests: number; errors: number; tokens: number; cost_usd: number };
  teams: Node[];
  owners: Node[];
  keys: Node[];
}

const RANGES = [
  [1, "1h"],
  [6, "6h"],
  [24, "24h"],
  [72, "3d"],
  [168, "7d"],
] as const;

/** Collapsible breakdown row: a group with nested model/provider/account tables. */
function Detail({ rows }: { rows?: Grp[] }) {
  const top = (rows ?? []).slice(0, 8);
  if (!top.length) return null;
  const max = Math.max(...top.map((g) => g.requests), 1);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {top.map((g) => (
        <div key={g.name} className="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-3">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <span className="truncate font-mono text-[11px] text-zinc-300">{g.name}</span>
            <span className="shrink-0 text-[10px] text-zinc-500">
              {fmt.n(g.requests)} req · {fmt.k(g.tokens)} tok {g.cost_usd ? `· ${fmt.usd(g.cost_usd)}` : ""}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500"
              style={{ width: `${(g.requests / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function Row({
  node,
  icon,
  meta,
  children,
  defaultOpen,
}: {
  node: Node;
  icon: "team" | "user" | "key";
  meta?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const Icon = icon === "team" ? UsersRound : icon === "user" ? Users : KeyRound;
  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition hover:bg-zinc-800/30"
      >
        {open ? <ChevronDown size={14} className="shrink-0 text-zinc-500" /> : <ChevronRight size={14} className="shrink-0 text-zinc-500" />}
        <Icon size={14} className="shrink-0 text-emerald-400/80" />
        <span className="shrink-0 font-medium text-zinc-100">{node.name || <span className="text-zinc-500">(không team)</span>}</span>
        {meta && <span className="truncate font-mono text-[10px] text-zinc-500">{meta}</span>}
        {node.team ? (
          <Badge tone="cyan">{node.team}</Badge>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-3 text-[11px] tabular-nums">
          <span className="text-zinc-300">{fmt.n(node.requests)} <span className="text-zinc-600">req</span></span>
          <span className="text-cyan-300/90">{fmt.k(node.tokens)} <span className="text-zinc-600">tok</span></span>
          {node.cost_usd ? <span className="text-amber-300/90">{fmt.usd(node.cost_usd)}</span> : null}
          {node.errors ? <span className="text-rose-400">{node.errors} lỗi</span> : null}
        </span>
      </button>
      {open && <div className="space-y-3 border-t border-zinc-800/60 px-3 py-3">{children}</div>}
    </div>
  );
}

/**
 * Admin monitor: per-team / per-user / per-key usage with nested model,
 * provider and account breakdowns. Data comes from /admin/insights (BFF
 * allows admins only). Mounted inside the Usage page.
 */
export default function Monitor() {
  const [hours, setHours] = useState(24);
  const [view, setView] = useState<"teams" | "owners" | "keys">("teams");
  const { data, error } = useJson<Insights>(`/admin/insights?hours=${hours}`, 15000);

  const nodes = data?.[view] ?? [];

  return (
    <Panel
      title="Monitor — Team · User · API key"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={view}
            options={[
              ["teams", "Team"],
              ["owners", "User"],
              ["keys", "API key"],
            ] as const}
            onChange={setView}
          />
          <Segmented value={hours} options={RANGES} onChange={setHours} />
        </div>
      }
    >
      <p className="-mt-2 mb-3 text-[11px] text-zinc-500">
        Ai dùng bao nhiêu token/request, model nào, provider &amp; account nào (dữ liệu trong bộ nhớ, 7 ngày gần nhất).
      </p>
      {error ? (
        <p className="text-xs text-zinc-500">Không tải được dữ liệu monitor: {String(error)}</p>
      ) : !data ? (
        <Empty icon={Database}>Đang tải…</Empty>
      ) : !nodes.length ? (
        <Empty icon={Database}>Chưa có request nào trong {hours}h qua.</Empty>
      ) : (
        <div className="space-y-2">
          {/* headline */}
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-zinc-800/60 bg-zinc-950/50 px-3 py-2 text-[11px] text-zinc-400">
            <span>Tổng {fmt.n(data.totals.requests)} request · {fmt.k(data.totals.tokens)} token</span>
            <span className="text-amber-300/90">{fmt.usd(data.totals.cost_usd)}</span>
            {data.totals.errors ? <span className="text-rose-400">{data.totals.errors} lỗi</span> : null}
          </div>

          {view === "teams" &&
            nodes.map((n) => (
              <Row key={n.name} node={n} icon="team">
                <Detail rows={n.by_model} />
                <Detail rows={n.by_account} />
                <Detail rows={n.by_key} />
                <Detail rows={n.by_owner} />
              </Row>
            ))}

          {view === "owners" &&
            nodes.map((n) => (
              <Row key={n.name} node={n} icon="user" meta={n.team ? `team ${n.team}` : "không team"}>
                <Detail rows={n.by_model} />
                <Detail rows={n.by_account} />
                <Detail rows={n.by_key} />
              </Row>
            ))}

          {view === "keys" &&
            nodes.map((n) => (
              <Row key={n.name} node={n} icon="key" meta={`owner ${n.owner ?? "?"}`}>
                <Detail rows={n.by_model} />
                <Detail rows={n.by_provider} />
                <Detail rows={n.by_account} />
              </Row>
            ))}
        </div>
      )}
    </Panel>
  );
}
