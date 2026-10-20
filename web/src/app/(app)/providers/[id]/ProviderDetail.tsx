"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, Boxes, ListChecks, Plug, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { entryFor, findEntry, type CatalogEntry } from "@/lib/catalog";
import { Badge, Btn, Empty, Field, Panel } from "@/components/ui";
import { describeTest, type TestResult } from "../ConnectCard";
import { GithubDevice, KeyForm, connectionBody, inputCls, ClaudeOAuth } from "../ConnectForms";
import { ProviderIcon, useConnections, type ConnAccount } from "../ProviderCatalog";

interface PoolStatus {
  label: string;
  requests: number;
  failures: number;
  rate_limited: number;
  cooldown_remaining_ms: number | null;
}

type Tab = "accounts" | "models" | "settings";

export default function ProviderDetail({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const router = useRouter();
  const { conns, providers, load, loaded } = useConnections();
  const conn = conns.find((c) => c.name === id);
  const live = providers.find((p) => p.name === id);
  const base = entryFor(id, conn);
  const entry: CatalogEntry | undefined = base && conn
    ? { ...base, prefix: conn.prefix ?? base.prefix, models: conn.models.length ? conn.models : base.models, baseUrl: conn.base_url || base.baseUrl }
    : base;

  const [tab, setTab] = useState<Tab>("accounts");
  const [pool, setPool] = useState<PoolStatus[]>([]);

  const loadPool = useCallback(async () => {
    const r = await fetch(`/api/proxy/admin/providers/${id}/accounts`);
    if (r.ok) setPool((await r.json()).accounts ?? []);
    else setPool([]);
  }, [id]);

  useEffect(() => {
    loadPool();
  }, [loadPool]);

  const refresh = () => {
    load();
    loadPool();
  };

  if (!loaded) return <p className="text-xs text-zinc-500">Đang tải…</p>;
  if (!entry) {
    return (
      <div className="space-y-3">
        <Link href="/providers" className="text-xs text-zinc-400 hover:text-zinc-200">← Providers</Link>
        <p className="text-sm text-red-400">Không tìm thấy provider “{id}”.</p>
      </div>
    );
  }

  const models = live?.models.length ? live.models : entry.models;
  const prefix = conn?.prefix ?? entry.prefix;

  return (
    <div className="space-y-6">
      <Link
        href="/providers"
        className="group inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 transition-colors hover:text-emerald-400"
      >
        <ChevronLeft size={14} className="transition-transform group-hover:-translate-x-0.5" />
        Providers
      </Link>

      <header className="flex flex-wrap items-center gap-4">
        <ProviderIcon entry={entry} size={12} />
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-bold tracking-tight text-zinc-50">{entry.name}</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-zinc-500">
            <code className="rounded-md bg-zinc-800/60 px-1.5 py-0.5 font-mono text-[11px]">{id}</code>
            <span className="text-zinc-700">·</span>
            <span>{entry.format}</span>
            {entry.baseUrl && (
              <>
                <span className="text-zinc-700">·</span>
                <code className="truncate font-mono text-[11px]">{entry.baseUrl}</code>
              </>
            )}
            {live?.yaml && <Badge tone="cyan">YAML</Badge>}
            {conn?.disabled && <Badge tone="amber">đã tắt</Badge>}
          </p>
        </div>
        <div className="flex gap-2.5">
          <Stat label="Accounts" value={live?.accounts ?? 0} tone="emerald" />
          <Stat label="Models" value={models.length} tone="cyan" />
          <Stat label="Requests" value={pool.reduce((s, p) => s + p.requests, 0)} tone="violet" />
          <Stat label="Lỗi" value={pool.reduce((s, p) => s + p.failures, 0)} tone={pool.reduce((s, p) => s + p.failures, 0) > 0 ? "rose" : "emerald"} />
        </div>
      </header>

      {entry.blocked ? (
        <Blocked entry={entry} />
      ) : entry.soon ? (
        <div className="rounded-2xl border border-zinc-800/70 bg-zinc-900/40 p-5 text-xs text-zinc-400">{entry.soon}</div>
      ) : (
        <>
          <nav className="flex gap-1 border-b border-zinc-800/70">
            {(["accounts", "models", "settings"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`-mb-px border-b-2 px-4 py-2.5 text-[13px] font-medium transition-all ${
                  tab === t
                    ? "border-emerald-500 text-emerald-300"
                    : "border-transparent text-zinc-500 hover:border-zinc-700 hover:text-zinc-200"
                }`}
              >
                {t === "accounts" ? "Connections" : t === "models" ? "Models" : "Cài đặt"}
              </button>
            ))}
          </nav>

          {tab === "accounts" && (
            <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
              <Accounts id={id} accounts={conn?.accounts ?? []} pool={pool} isAdmin={isAdmin} onChanged={refresh} yamlOnly={!!live?.yaml} />
              {isAdmin && (
                <Panel title="Thêm connection" icon={Plus} className="h-fit">
                  {entry.oauth === "github-device" && <GithubDevice onDone={refresh} />}
                  {entry.oauth === "openrouter-pkce" && (
                    <div className="space-y-3">
                      <a
                        href="/api/oauth/openrouter/start"
                        className="block rounded-xl border border-indigo-500/30 bg-gradient-to-b from-indigo-500 to-indigo-600 px-4 py-2.5 text-center text-xs font-semibold text-white shadow-lg shadow-indigo-900/30 transition-all hover:from-indigo-400 hover:to-indigo-500 active:scale-[0.98]"
                      >
                        Đăng nhập OpenRouter &amp; Connect
                      </a>
                      <p className="text-center text-[11px] text-zinc-500">hoặc dán API key</p>
                      <KeyForm entry={entry} onDone={refresh} />
                    </div>
                  )}
                  {entry.oauth === "claude-pkce" && <ClaudeOAuth onDone={refresh} />}
                  {!entry.oauth && <KeyForm entry={entry} onDone={refresh} />}
                </Panel>
              )}
            </div>
          )}

          {tab === "models" && (
            <Models id={id} entry={entry} models={models} prefix={prefix} isAdmin={isAdmin} connected={(live?.accounts ?? 0) > 0} onChanged={refresh} canEdit={!live?.yaml} />
          )}

          {tab === "settings" && (
            <Settings
              id={id}
              entry={entry}
              conn={conn}
              isAdmin={isAdmin}
              yaml={!!live?.yaml}
              onChanged={refresh}
              onDeleted={() => router.push("/providers")}
            />
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone = "emerald" }: { label: string; value: number; tone?: "emerald" | "cyan" | "violet" | "rose" }) {
  const t = {
    emerald: "text-emerald-300",
    cyan: "text-cyan-300",
    violet: "text-violet-300",
    rose: "text-rose-300",
  }[tone];
  return (
    <div className="min-w-[72px] rounded-xl border border-zinc-800/70 bg-zinc-900/40 px-3.5 py-2 text-center">
      <div className={`text-lg font-bold tabular-nums leading-none ${t}`}>{value}</div>
      <div className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
    </div>
  );
}

function Blocked({ entry }: { entry: CatalogEntry }) {
  return (
    <section className="space-y-3 rounded-2xl border border-amber-500/25 bg-amber-950/10 p-5">
      <p className="text-xs leading-relaxed text-amber-400">{entry.blocked}</p>
      {entry.alternatives?.length ? (
        <>
          <p className="text-xs text-zinc-300">Dùng cùng model một cách hợp lệ qua:</p>
          <div className="flex flex-wrap gap-2">
            {entry.alternatives.map((alt) => {
              const a = findEntry(alt);
              return a ? (
                <Link
                  key={alt}
                  href={`/providers/${alt}`}
                  className="rounded-xl border border-zinc-700/70 bg-zinc-900/50 px-3.5 py-2 text-xs font-medium text-zinc-200 transition-all hover:border-zinc-600 hover:bg-zinc-800 active:scale-[0.98]"
                >
                  {a.name} →
                </Link>
              ) : null;
            })}
          </div>
        </>
      ) : null}
    </section>
  );
}

function Accounts({
  id, accounts, pool, isAdmin, onChanged, yamlOnly,
}: {
  id: string; accounts: ConnAccount[]; pool: PoolStatus[]; isAdmin: boolean; onChanged: () => void; yamlOnly: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const saved = new Set(accounts.map((a) => a.label));
  // YAML accounts live only in the router pool (read-only here)
  const yamlAccounts = yamlOnly ? pool.filter((p) => !saved.has(p.label)) : [];

  async function patch(label: string, body: Record<string, unknown>) {
    setBusy(true);
    await fetch(`/api/proxy/admin/connections/${id}/accounts/${encodeURIComponent(label)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    onChanged();
  }

  async function test(label: string) {
    setBusy(true);
    const r = await fetch(`/api/proxy/admin/providers/${id}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    });
    setBusy(false);
    const res = (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as TestResult;
    setTests((t) => ({ ...t, [label]: res }));
  }

  async function disconnect(label: string) {
    if (!confirm(`Ngắt ${label}?`)) return;
    setBusy(true);
    await fetch("/api/oauth/disconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: id, label }),
    });
    setBusy(false);
    onChanged();
  }

  if (!accounts.length && !yamlAccounts.length) {
    return (
      <Empty icon={Plug}>
        Chưa có connection nào. {isAdmin ? "Thêm ở khung bên phải." : ""}
      </Empty>
    );
  }

  return (
    <section className="space-y-2.5">
      <p className="text-[11px] leading-relaxed text-zinc-500">
        Router chọn account theo <b className="text-zinc-400">priority</b> cao trước; cùng priority thì xoay vòng theo <b className="text-zinc-400">weight</b>. Account bị 429 sẽ cooldown rồi tự quay lại.
      </p>
      {accounts.map((a) => {
        const st = pool.find((p) => p.label === a.label);
        const cd = st?.cooldown_remaining_ms ?? 0;
        return (
          <div
            key={a.label}
            className={`group rounded-2xl border p-4 transition-all duration-300 ${
              a.disabled
                ? "border-zinc-800/60 bg-zinc-900/20 opacity-60"
                : cd > 0
                  ? "border-amber-500/25 bg-amber-950/10"
                  : "border-zinc-800/70 bg-zinc-900/40 hover:border-zinc-700/80"
            }`}
          >
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={`h-2 w-2 shrink-0 rounded-full transition-colors ${
                  a.disabled ? "bg-zinc-600" : cd > 0 ? "bg-amber-500 animate-pulse-glow" : "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-zinc-100">{a.label}</div>
                <div className="mt-0.5 font-mono text-[11px] text-zinc-500">
                  {a.key}
                  {st && (
                    <>
                      {" "}
                      · <span className="text-zinc-400">{st.requests} req</span> · {st.failures} lỗi · {st.rate_limited}×429
                    </>
                  )}
                  {cd > 0 && <span className="text-amber-400"> · cooldown {(cd / 1000).toFixed(0)}s</span>}
                </div>
              </div>
              {isAdmin && (
                <>
                  <label className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                    priority
                    <input
                      type="number"
                      defaultValue={a.priority}
                      disabled={busy}
                      className="w-16 rounded-lg border border-zinc-800 bg-zinc-950/70 px-2 py-1 text-xs text-zinc-200 outline-none transition-all focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/10"
                      onBlur={(e) => Number(e.target.value) !== a.priority && patch(a.label, { priority: Number(e.target.value) })}
                    />
                  </label>
                  <label className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                    weight
                    <input
                      type="number"
                      min={1}
                      defaultValue={a.weight}
                      disabled={busy}
                      className="w-14 rounded-lg border border-zinc-800 bg-zinc-950/70 px-2 py-1 text-xs text-zinc-200 outline-none transition-all focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/10"
                      onBlur={(e) => Number(e.target.value) !== a.weight && patch(a.label, { weight: Number(e.target.value) })}
                    />
                  </label>
                  <Toggle on={!a.disabled} disabled={busy} onChange={(on) => patch(a.label, { disabled: !on })} />
                  <Btn size="sm" disabled={busy || a.disabled} onClick={() => test(a.label)}>
                    Test
                  </Btn>
                  <Btn size="sm" variant="danger" disabled={busy} onClick={() => disconnect(a.label)}>
                    Ngắt
                  </Btn>
                </>
              )}
            </div>
            {tests[a.label] && (
              <p
                className={`mt-2.5 break-all rounded-lg border px-3 py-2 font-mono text-[11px] animate-fade-in ${
                  tests[a.label].ok
                    ? "border-emerald-500/25 bg-emerald-950/20 text-emerald-300"
                    : "border-rose-500/25 bg-rose-950/20 text-rose-300"
                }`}
              >
                {describeTest(tests[a.label])}
              </p>
            )}
          </div>
        );
      })}
      {yamlAccounts.map((p) => (
        <div key={p.label} className="flex flex-wrap items-center gap-3 rounded-2xl border border-zinc-800/70 bg-zinc-900/40 p-4 text-xs text-zinc-400">
          <Badge tone="cyan">YAML</Badge>
          <span className="font-semibold text-zinc-200">{p.label}</span>
          <span className="font-mono text-[11px] text-zinc-500">
            {p.requests} req · {p.failures} lỗi
          </span>
          {isAdmin && (
            <Btn size="sm" onClick={() => test(p.label)}>
              Test
            </Btn>
          )}
          {tests[p.label] && (
            <p
              className={`mt-1 w-full break-all rounded-lg border px-3 py-2 font-mono text-[11px] animate-fade-in ${
                tests[p.label].ok ? "border-emerald-500/25 bg-emerald-950/20 text-emerald-300" : "border-rose-500/25 bg-rose-950/20 text-rose-300"
              }`}
            >
              {describeTest(tests[p.label])}
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={() => onChange(!on)}
      title={on ? "Đang bật" : "Đang tắt"}
      className={`relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-full border transition-all duration-300 disabled:opacity-40 ${
        on
          ? "border-emerald-500/40 bg-emerald-500/90 shadow-[0_0_12px_rgba(16,185,129,0.25)]"
          : "border-zinc-700 bg-zinc-800"
      }`}
    >
      <span
        className={`inline-block h-[18px] w-[18px] rounded-full bg-white shadow transition-transform duration-300 ${
          on ? "translate-x-[19px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}

function Models({
  id, entry, models, prefix, isAdmin, connected, onChanged, canEdit,
}: {
  id: string; entry: CatalogEntry; models: string[]; prefix?: string | null; isAdmin: boolean; connected: boolean; onChanged: () => void; canEdit: boolean;
}) {
  const [text, setText] = useState(models.join("\n"));
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  async function fetchModels() {
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/proxy/admin/connections/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: id }),
    });
    setBusy(false);
    const d = await r.json().catch(() => ({}));
    if (d.ok) {
      setText(d.models.join("\n"));
      setMsg(`✓ Upstream trả ${d.models.length} model — bấm Lưu để áp dụng`);
    } else setMsg(`✗ ${d.error?.message ?? d.error ?? r.status}`);
  }

  async function save() {
    const list = text.split(/[\n,]/).map((m) => m.trim()).filter(Boolean);
    setBusy(true);
    const r = await fetch("/api/proxy/admin/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...connectionBody({ ...entry, models: list }, []), merge: true }),
    });
    setBusy(false);
    const b = await r.json().catch(() => ({}));
    setMsg(r.ok ? `✓ Đã lưu ${list.length} model` : `✗ ${b.error?.message ?? b.error ?? r.status}`);
    if (r.ok) onChanged();
  }

  function copy(s: string) {
    navigator.clipboard?.writeText(s);
    setCopied(s);
    setTimeout(() => setCopied(null), 1200);
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Panel title="Model ID để gọi" icon={Boxes}>
        <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">
          Bấm để copy. Dạng có prefix luôn đi đúng provider này; tên trần cho phép router chọn provider rẻ nhất/fallback.
        </p>
        <div className="max-h-96 space-y-1.5 overflow-auto pr-1">
          {models.map((m) => (
            <div key={m} className="flex flex-wrap gap-1.5 font-mono text-[11px]">
              {[prefix ? `${prefix}/${m}` : null, `${id}/${m}`, m].filter(Boolean).map((s) => (
                <button
                  key={s}
                  onClick={() => copy(s!)}
                  className={`rounded-lg border px-2 py-1 transition-all active:scale-95 ${
                    copied === s
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                      : "border-zinc-800 bg-zinc-900/50 text-zinc-300 hover:border-emerald-500/40 hover:bg-zinc-800"
                  }`}
                >
                  {copied === s ? "✓ copied" : s}
                </button>
              ))}
            </div>
          ))}
          {!models.length && <p className="text-xs text-zinc-600">Chưa có model.</p>}
        </div>
      </Panel>

      {isAdmin && canEdit && (
        <Panel
          title="Danh sách model"
          icon={ListChecks}
          actions={
            <Btn size="sm" onClick={fetchModels} disabled={busy || !connected} title={connected ? "" : "Cần ít nhất 1 connection"}>
              <RefreshCw size={12} />
              Lấy từ upstream
            </Btn>
          }
        >
          <textarea rows={14} value={text} onChange={(e) => setText(e.target.value)} className={`${inputCls} font-mono`} />
          <div className="mt-3 flex items-center gap-3">
            <Btn variant="primary" onClick={save} disabled={busy || !connected}>
              Lưu
            </Btn>
            {msg && (
              <span className={`text-xs font-medium animate-fade-in ${msg.startsWith("✓") ? "text-emerald-400" : "text-rose-400"}`}>{msg}</span>
            )}
          </div>
        </Panel>
      )}
      {!canEdit && <p className="text-[11px] text-zinc-500">Model của provider YAML sửa ở trang Config.</p>}
    </div>
  );
}

function Settings({
  id, entry, conn, isAdmin, yaml, onChanged, onDeleted,
}: {
  id: string; entry: CatalogEntry; conn?: { prefix?: string | null; disabled: boolean; display_name?: string | null; base_url: string }; isAdmin: boolean; yaml: boolean; onChanged: () => void; onDeleted: () => void;
}) {
  const [prefix, setPrefix] = useState(conn?.prefix ?? entry.prefix ?? "");
  const [baseUrl, setBaseUrl] = useState(conn?.base_url || entry.baseUrl);
  const [msg, setMsg] = useState<string | null>(null);

  if (!isAdmin) return <p className="text-xs text-zinc-500">Chỉ admin được sửa cài đặt.</p>;
  if (!conn) return <p className="text-xs text-zinc-500">Kết nối ít nhất 1 account trước khi chỉnh cài đặt.</p>;

  async function save(extra: Record<string, unknown> = {}) {
    const r = await fetch("/api/proxy/admin/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...connectionBody({ ...entry, models: [], baseUrl: entry.custom ? baseUrl : entry.baseUrl }, []),
        base_url: entry.custom ? baseUrl : "",
        models: [],
        prefix: prefix.trim(),
        merge: true,
        ...extra,
      }),
    });
    const b = await r.json().catch(() => ({}));
    setMsg(r.ok ? "✓ Đã lưu" : `✗ ${b.error?.message ?? b.error ?? r.status}`);
    if (r.ok) onChanged();
  }

  async function removeAll() {
    if (!confirm(`Xoá toàn bộ connection của ${entry.name}?`)) return;
    const r = await fetch("/api/oauth/disconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: id }),
    });
    if (r.ok) onDeleted();
  }

  return (
    <Panel className="max-w-xl" title="Cài đặt" icon={Settings2}>
      <div className="space-y-4">
        <Field label="Prefix" hint={<>Gọi model dạng <code className="rounded bg-zinc-800/60 px-1 py-0.5 font-mono text-[10px]">{prefix || "prefix"}/&lt;model&gt;</code> để ép đi provider này.</>}>
          <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="vd: gh" className={inputCls} />
        </Field>
        {entry.custom && (
          <Field label="Base URL">
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className={inputCls} />
          </Field>
        )}
        <div className="flex items-center justify-between rounded-2xl border border-zinc-800/70 bg-zinc-900/30 px-4 py-3">
          <div>
            <div className="text-xs font-semibold text-zinc-200">Bật provider</div>
            <div className="text-[11px] text-zinc-500">Tắt = giữ nguyên account nhưng router không dùng.</div>
          </div>
          <Toggle on={!conn.disabled} onChange={(on) => save({ disabled: !on })} />
        </div>
        <div className="flex items-center gap-3">
          <Btn variant="primary" onClick={() => save()}>
            Lưu
          </Btn>
          {msg && <span className={`text-xs font-medium animate-fade-in ${msg.startsWith("✓") ? "text-emerald-400" : "text-rose-400"}`}>{msg}</span>}
        </div>
        <div className="border-t border-zinc-800/60 pt-4">
          <Btn variant="danger" size="lg" onClick={removeAll}>
            <Trash2 size={14} />
            {yaml ? "Xoá các connection thêm từ dashboard" : "Xoá provider"}
          </Btn>
        </div>
      </div>
    </Panel>
  );
}
