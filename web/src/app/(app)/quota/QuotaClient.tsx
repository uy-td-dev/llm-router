"use client";

import { useMemo, useState } from "react";
import { Ban, Clock, Gauge, Pencil, Search, ShieldCheck, Timer, Users } from "lucide-react";
import { Badge, Btn, Empty, Field, PageHeader, Panel, Stat, api, fmt, inputCls, useFlash, useJson } from "@/components/ui";

interface Quota {
  requests_per_day: number | null;
  tokens_per_day: number | null;
  usd_per_month: number | null;
}
interface Row {
  provider: string;
  label: string;
  requests_today: number;
  tokens_today: number;
  usd_month: number;
  quota: Quota;
  exhausted: boolean;
  cooldown_remaining_ms: number | null;
  total_requests: number;
  failures: number;
  rate_limited: number;
}

function Meter({ used, limit, format }: { used: number; limit: number | null; format: (v: number) => string }) {
  if (!limit) {
    return (
      <div className="text-[11px] tabular-nums text-zinc-400">
        {format(used)} <span className="text-zinc-600">/ ∞</span>
      </div>
    );
  }
  const pct = Math.min(100, (used / limit) * 100);
  const grad = pct >= 100 ? "from-rose-500 to-rose-400" : pct >= 80 ? "from-amber-500 to-orange-400" : "from-emerald-500 to-teal-400";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px] tabular-nums">
        <span className="text-zinc-300">{format(used)}</span>
        <span className="text-zinc-600">/ {format(limit)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800/80">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${grad} transition-[width] duration-700 ease-out`}
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </div>
    </div>
  );
}

export default function QuotaClient({ isAdmin }: { isAdmin: boolean }) {
  const { flash, node } = useFlash();
  const { data, reload } = useJson<{ rows: Row[]; reset_in_secs: number }>("/admin/quotas", 5000);
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<Row | null>(null);

  const rows = useMemo(
    () => (data?.rows ?? []).filter((r) => `${r.provider}/${r.label}`.toLowerCase().includes(q.toLowerCase())),
    [data, q],
  );
  const groups = useMemo(() => {
    const m = new Map<string, Row[]>();
    rows.forEach((r) => m.set(r.provider, [...(m.get(r.provider) ?? []), r]));
    return [...m.entries()];
  }, [rows]);

  const all = data?.rows ?? [];
  const exhausted = all.filter((r) => r.exhausted).length;
  const cooling = all.filter((r) => r.cooldown_remaining_ms).length;
  const limited = all.filter((r) => r.quota.requests_per_day || r.quota.tokens_per_day || r.quota.usd_per_month).length;

  return (
    <div className="space-y-6">
      {node}
      <PageHeader
        icon={Gauge}
        title="Quota Tracker"
        desc="Theo dõi mức dùng của từng tài khoản upstream và đặt giới hạn theo ngày hoặc tháng. Tài khoản chạm giới hạn sẽ tạm bị loại khỏi vòng xoay; router tự chuyển sang tài khoản hoặc provider kế tiếp (đúng cơ chế fallback của combo)."
      />

      <div className="stagger-children grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <Stat label="Tài khoản" value={all.length} icon={Users} />
        <Stat label="Có giới hạn" value={limited} icon={ShieldCheck} tone="cyan" />
        <Stat label="Hết quota" value={exhausted} icon={Ban} tone="rose" />
        <Stat label="Reset sau" value={fmt.dur(data?.reset_in_secs ?? 0)} icon={Timer} tone="violet" sub={`${cooling} tài khoản đang cooldown 429`} />
      </div>

      <div className="relative max-w-xs">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Lọc provider / account…" className={`${inputCls} pl-9`} />
      </div>

      {groups.length ? (
        groups.map(([provider, list]) => (
          <Panel key={provider} title={<>{provider} <Badge>{list.length}</Badge></>} icon={Gauge}>
            <div className="grid gap-3.5 md:grid-cols-2 xl:grid-cols-3">
              {list.map((r) => (
                <div
                  key={r.label}
                  className={`group relative overflow-hidden rounded-2xl border p-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/25 ${
                    r.exhausted
                      ? "border-rose-500/25 bg-rose-950/10"
                      : "border-zinc-800/70 bg-zinc-900/40 hover:border-zinc-700/80"
                  }`}
                >
                  {r.exhausted && (
                    <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-rose-500/40 to-transparent" />
                  )}
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[12px] font-semibold text-zinc-100">{r.label}</div>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {r.exhausted ? <Badge tone="rose">hết quota</Badge> : <Badge tone="emerald">hoạt động</Badge>}
                        {r.cooldown_remaining_ms ? (
                          <Badge tone="amber">
                            <Clock size={9} /> 429 · {Math.ceil(r.cooldown_remaining_ms / 1000)}s
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                    {isAdmin && (
                      <button
                        onClick={() => setEdit(r)}
                        className="rounded-lg p-2 text-zinc-500 opacity-0 transition-all hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100"
                        title="Đặt giới hạn"
                      >
                        <Pencil size={13} />
                      </button>
                    )}
                  </div>
                  <div className="space-y-3">
                    <div>
                      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Requests hôm nay</div>
                      <Meter used={r.requests_today} limit={r.quota.requests_per_day} format={fmt.n} />
                    </div>
                    <div>
                      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Tokens hôm nay</div>
                      <Meter used={r.tokens_today} limit={r.quota.tokens_per_day} format={fmt.k} />
                    </div>
                    <div>
                      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Chi phí tháng này</div>
                      <Meter used={r.usd_month} limit={r.quota.usd_per_month} format={fmt.usd} />
                    </div>
                  </div>
                  <div className="mt-3 flex gap-3 border-t border-zinc-800/60 pt-3 text-[10px] text-zinc-500">
                    <span>tổng <span className="text-zinc-400">{fmt.n(r.total_requests)}</span></span>
                    <span className={r.failures ? "text-rose-400/80" : ""}>lỗi {r.failures}</span>
                    <span className={r.rate_limited ? "text-amber-400/80" : ""}>429 × {r.rate_limited}</span>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        ))
      ) : (
        <Empty icon={Users}>Chưa có tài khoản upstream nào. Hãy kết nối provider trước.</Empty>
      )}

      {edit && (
        <QuotaEditor
          row={edit}
          onClose={() => setEdit(null)}
          onSave={async (quota) => {
            try {
              await api("/admin/quotas", { body: { provider: edit.provider, label: edit.label, quota } });
              flash("✓ Đã lưu giới hạn");
              setEdit(null);
              reload();
            } catch (e) {
              flash(`✗ ${(e as Error).message}`);
            }
          }}
        />
      )}
    </div>
  );
}

function QuotaEditor({ row, onClose, onSave }: { row: Row; onClose: () => void; onSave: (q: Quota | null) => void }) {
  const [req, setReq] = useState(row.quota.requests_per_day?.toString() ?? "");
  const [tok, setTok] = useState(row.quota.tokens_per_day?.toString() ?? "");
  const [usd, setUsd] = useState(row.quota.usd_per_month?.toString() ?? "");
  const num = (s: string) => (s.trim() ? Number(s) : null);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="animate-fade-in w-full max-w-sm space-y-4 rounded-2xl border border-zinc-800/70 bg-zinc-900/80 p-6 shadow-2xl shadow-black/60 backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-zinc-800/60 pb-3">
          <h3 className="text-sm font-semibold tracking-tight text-zinc-100">Giới hạn tài khoản</h3>
          <p className="mt-0.5 font-mono text-[11px] text-zinc-500">
            {row.provider}/{row.label}
          </p>
        </div>
        <Field label="Requests / ngày" hint="Để trống = không giới hạn">
          <input type="number" min={0} value={req} onChange={(e) => setReq(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Tokens / ngày">
          <input type="number" min={0} value={tok} onChange={(e) => setTok(e.target.value)} className={inputCls} />
        </Field>
        <Field label="USD / tháng">
          <input type="number" min={0} step="0.01" value={usd} onChange={(e) => setUsd(e.target.value)} className={inputCls} />
        </Field>
        <div className="flex gap-2 pt-1">
          <Btn onClick={() => onSave(null)} className="flex-1" size="lg">
            Bỏ giới hạn
          </Btn>
          <Btn variant="primary" className="flex-1" size="lg" onClick={() => onSave({ requests_per_day: num(req), tokens_per_day: num(tok), usd_per_month: num(usd) })}>
            Lưu
          </Btn>
        </div>
      </div>
    </div>
  );
}
