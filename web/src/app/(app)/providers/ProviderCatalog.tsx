"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { CATALOG, SECTIONS, entryFor, type CatalogEntry, type Format } from "@/lib/catalog";
import { Btn, Segmented } from "@/components/ui";
import { inputCls } from "./ConnectForms";

export interface ConnAccount {
  label: string;
  priority: number;
  weight: number;
  disabled: boolean;
  key: string;
}
export interface ConnSummary {
  name: string;
  display_name?: string | null;
  format: string;
  base_url: string;
  prefix?: string | null;
  disabled: boolean;
  accounts: ConnAccount[];
  models: string[];
  yaml: boolean;
}
export interface ProviderSummary {
  name: string;
  format: string;
  models: string[];
  accounts: number;
  yaml: boolean;
}

export function useConnections() {
  const [conns, setConns] = useState<ConnSummary[]>([]);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    const r = await fetch("/api/proxy/admin/connections");
    if (r.ok) {
      const d = await r.json();
      setConns(d.connections ?? []);
      setProviders(d.providers ?? []);
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return { conns, providers, load, loaded };
}

type Filter = "all" | "connected" | "available";

export default function ProviderCatalog({ isAdmin }: { isAdmin: boolean }) {
  const { conns, providers, load } = useConnections();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [banner, setBanner] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("connected")) setBanner(`✓ Đã kết nối ${p.get("connected")}`);
    if (p.get("error")) setBanner(`✗ ${p.get("error")}`);
  }, []);

  function stat(id: string): { n: number; disabled: boolean } {
    // live pool size (enabled accounts with a credential)
    const n = providers.find((p) => p.name === id)?.accounts ?? 0;
    const c = conns.find((x) => x.name === id);
    return { n, disabled: c?.disabled ?? false };
  }

  const customEntries: CatalogEntry[] = useMemo(
    () => conns.filter((c) => !CATALOG.some((e) => e.id === c.name)).map((c) => entryFor(c.name, c)!),
    [conns]
  );

  const match = (e: CatalogEntry) => {
    if (q && !`${e.name} ${e.id}`.toLowerCase().includes(q.toLowerCase())) return false;
    const n = stat(e.id).n;
    if (filter === "connected") return n > 0;
    if (filter === "available") return n === 0 && !e.blocked;
    return true;
  };

  const sections: { title: string; items: CatalogEntry[] }[] = [
    ...SECTIONS.map((s) => ({ title: s.title, items: CATALOG.filter((e) => e.kind === s.kind) })),
    { title: "Custom Providers", items: customEntries },
  ];
  const total = CATALOG.length + customEntries.length;
  const connected = [...CATALOG, ...customEntries].filter((e) => stat(e.id).n > 0).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-56 max-w-xs flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
          <input
            placeholder="Tìm provider…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className={`${inputCls} pl-9`}
          />
        </div>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            ["all", `Tất cả (${total})`],
            ["connected", `Đã kết nối (${connected})`],
            ["available", "Chưa kết nối"],
          ] as const}
        />
        <span className="flex-1" />
        {isAdmin && (
          <Btn variant="primary" onClick={() => setCustom(true)}>
            <Plus size={14} />
            Custom provider
          </Btn>
        )}
      </div>

      {banner && (
        <div
          className={`animate-fade-in rounded-2xl border px-4 py-3 text-xs font-medium ${
            banner.startsWith("✓")
              ? "border-emerald-500/25 bg-emerald-950/20 text-emerald-300"
              : "border-rose-500/25 bg-rose-950/20 text-rose-300"
          }`}
        >
          {banner}
        </div>
      )}

      {sections.map((s) => {
        const items = s.items.filter(match);
        if (!items.length) return null;
        return (
          <section key={s.title}>
            <h2 className="mb-3 flex items-center gap-2 text-[13px] font-semibold tracking-tight text-zinc-300">
              {s.title}
              <span className="rounded-md bg-zinc-800/60 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                {items.length}
              </span>
            </h2>
            <div className="stagger-children grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
              {items.map((e) => {
                const { n, disabled } = stat(e.id);
                const active = n > 0 && !disabled;
                const status = e.blocked
                  ? "Không hỗ trợ"
                  : e.soon
                    ? "Sắp có"
                    : disabled
                      ? "Đã tắt"
                      : n
                        ? `${n} Connected`
                        : "No connections";
                return (
                  <Link
                    key={e.id}
                    href={`/providers/${e.id}`}
                    className={`group relative animate-fade-in overflow-hidden rounded-2xl border p-3.5 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/30 ${
                      active
                        ? "border-emerald-500/25 bg-emerald-950/15 hover:border-emerald-500/45"
                        : "border-zinc-800/70 bg-zinc-900/40 hover:border-zinc-600"
                    } ${e.blocked || e.soon || disabled ? "opacity-50" : ""}`}
                  >
                    {active && (
                      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/40 to-transparent" />
                    )}
                    <div className="flex items-center gap-3">
                      <ProviderIcon entry={e} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-zinc-200">{e.name}</span>
                        <span
                          className={`mt-0.5 flex items-center gap-1.5 text-[11px] ${
                            active ? "text-emerald-400" : "text-zinc-500"
                          }`}
                        >
                          {active && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />}
                          {status}
                        </span>
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}

      {custom && <CustomProviderModal onClose={() => setCustom(false)} onSaved={load} existing={[...CATALOG.map((e) => e.id), ...conns.map((c) => c.name)]} />}
    </div>
  );
}

export function ProviderIcon({ entry, size = 9 }: { entry: CatalogEntry; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white shadow-lg shadow-black/30 ring-1 ring-white/10"
      style={{ background: entry.color, width: size * 4, height: size * 4 }}
    >
      {entry.name[0]?.toUpperCase()}
    </span>
  );
}

function CustomProviderModal({ onClose, onSaved, existing }: { onClose: () => void; onSaved: () => void; existing: string[] }) {
  const router = useRouter();
  const [f, setF] = useState({ name: "", display: "", format: "openai" as Format, base_url: "", api_key: "", prefix: "", models: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const id = f.name.trim().toLowerCase();
  const models = f.models.split(/[\n,]/).map((m) => m.trim()).filter(Boolean);

  async function fetchModels() {
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/proxy/admin/connections/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: f.format, base_url: f.base_url.trim(), api_key: f.api_key.trim() }),
    });
    setBusy(false);
    const d = await r.json().catch(() => ({}));
    if (d.ok) {
      setF((x) => ({ ...x, models: d.models.join("\n") }));
      setMsg(`✓ Lấy được ${d.models.length} model`);
    } else setMsg(`✗ ${d.error?.message ?? d.error ?? r.status}`);
  }

  async function save() {
    if (existing.includes(id)) return setMsg("✗ Tên đã tồn tại");
    setBusy(true);
    const r = await fetch("/api/proxy/admin/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: id,
        display_name: f.display.trim() || undefined,
        format: f.format,
        base_url: f.base_url.trim(),
        prefix: f.prefix.trim() || undefined,
        models: models.map((name) => ({ name })),
        accounts: f.api_key.trim() ? [{ label: `${id}-1`, api_key: f.api_key.trim() }] : [],
      }),
    });
    setBusy(false);
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      return setMsg(`✗ ${b.error?.message ?? b.error ?? r.status}`);
    }
    onSaved();
    router.push(`/providers/${id}`);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="animate-fade-in w-full max-w-lg space-y-3.5 rounded-2xl border border-zinc-800/70 bg-zinc-900/80 p-6 shadow-2xl shadow-black/60 backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800/60 pb-3">
          <h3 className="text-sm font-semibold tracking-tight text-zinc-100">Thêm custom provider</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200">
            <X size={16} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <input placeholder="id (vd: my-llm)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputCls} />
          <input placeholder="Tên hiển thị" value={f.display} onChange={(e) => setF({ ...f, display: e.target.value })} className={inputCls} />
          <select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value as Format })} className={inputCls}>
            <option value="openai">OpenAI-compatible</option>
            <option value="anthropic">Anthropic Messages</option>
            <option value="google">Gemini</option>
          </select>
          <input placeholder="prefix (vd: my)" value={f.prefix} onChange={(e) => setF({ ...f, prefix: e.target.value })} className={inputCls} />
        </div>
        <input placeholder="Base URL (vd: https://api.example.com/v1)" value={f.base_url} onChange={(e) => setF({ ...f, base_url: e.target.value })} className={inputCls} />
        <input type="password" placeholder="API key" value={f.api_key} onChange={(e) => setF({ ...f, api_key: e.target.value })} className={`${inputCls} font-mono`} />
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-zinc-500">Models (mỗi dòng một model)</span>
          <button
            onClick={fetchModels}
            disabled={busy || !f.base_url || !f.api_key}
            className="rounded-lg border border-zinc-700/70 bg-zinc-900/50 px-2.5 py-1 text-[11px] text-zinc-300 transition-all hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
          >
            Lấy từ /models
          </button>
        </div>
        <textarea rows={5} value={f.models} onChange={(e) => setF({ ...f, models: e.target.value })} className={`${inputCls} font-mono`} />
        {msg && (
          <p
            className={`animate-fade-in rounded-xl border px-3.5 py-2.5 text-xs ${
              msg.startsWith("✓")
                ? "border-emerald-500/25 bg-emerald-950/30 text-emerald-300"
                : "border-rose-500/25 bg-rose-950/30 text-rose-300"
            }`}
          >
            {msg}
          </p>
        )}
        <button
          onClick={save}
          disabled={busy || !id || !f.base_url || !models.length}
          className="w-full rounded-xl border border-emerald-500/30 bg-gradient-to-b from-emerald-500 to-emerald-600 py-2.5 text-xs font-semibold text-white shadow-lg shadow-emerald-900/30 transition-all hover:from-emerald-400 hover:to-emerald-500 active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100"
        >
          Tạo provider
        </button>
      </div>
    </div>
  );
}
