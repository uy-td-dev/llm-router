"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";

export const inputCls =
  "w-full rounded-xl border border-zinc-800 bg-zinc-950/70 px-3.5 py-2.5 text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none transition-all duration-200 hover:border-zinc-700 focus:border-emerald-500/50 focus:bg-zinc-950 focus:ring-4 focus:ring-emerald-500/[0.08]";

export function PageHeader({
  icon: Icon,
  title,
  desc,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  desc?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-start gap-3.5">
        <div className="group relative rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/20 to-cyan-500/10 p-2.5 text-emerald-300 transition-transform duration-300 hover:scale-105">
          <div className="absolute inset-0 rounded-2xl bg-emerald-500/20 blur-lg opacity-0 transition-opacity group-hover:opacity-100" />
          <Icon size={20} className="relative" />
        </div>
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold tracking-tight text-zinc-50">{title}</h1>
          {desc && <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-zinc-500">{desc}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({
  title,
  icon: Icon,
  actions,
  children,
  className = "",
  pad = true,
}: {
  title?: React.ReactNode;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <section
      className={`group relative overflow-hidden rounded-2xl border border-zinc-800/70 bg-zinc-900/40 shadow-lg shadow-black/20 transition-colors duration-300 hover:border-zinc-700/80 ${pad ? "p-5" : ""} ${className}`}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />
      {(title || actions) && (
        <div className={`flex items-center justify-between gap-3 ${pad ? "mb-4" : "border-b border-zinc-800/60 px-5 py-3.5"}`}>
          <h2 className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-zinc-200">
            {Icon && (
              <span className="grid h-6 w-6 place-items-center rounded-lg bg-zinc-800/70 text-zinc-400 transition-colors group-hover:text-emerald-400">
                <Icon size={13} />
              </span>
            )}
            {title}
          </h2>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

const TONES = {
  emerald: { grad: "from-emerald-500/20", text: "text-emerald-300", ring: "group-hover:border-emerald-500/30" },
  cyan: { grad: "from-cyan-500/20", text: "text-cyan-300", ring: "group-hover:border-cyan-500/30" },
  violet: { grad: "from-violet-500/20", text: "text-violet-300", ring: "group-hover:border-violet-500/30" },
  amber: { grad: "from-amber-500/20", text: "text-amber-300", ring: "group-hover:border-amber-500/30" },
  rose: { grad: "from-rose-500/20", text: "text-rose-300", ring: "group-hover:border-rose-500/30" },
} as const;

export function Stat({
  label,
  value,
  sub,
  icon: Icon,
  tone = "emerald",
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: LucideIcon;
  tone?: keyof typeof TONES;
  onClick?: () => void;
}) {
  const t = TONES[tone];
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className={`group relative overflow-hidden rounded-2xl border border-zinc-800/70 bg-zinc-900/40 p-4 text-left transition-all duration-300 hover:-translate-y-0.5 hover:bg-zinc-900/70 hover:shadow-xl hover:shadow-black/30 ${t.ring} ${onClick ? "cursor-pointer" : ""}`}
    >
      <div className={`pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full bg-gradient-to-br ${t.grad} to-transparent opacity-60 blur-2xl transition-opacity duration-500 group-hover:opacity-100`} />
      <div className="relative flex items-center justify-between gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-zinc-500">{label}</span>
        {Icon && (
          <span className={`grid h-7 w-7 place-items-center rounded-lg bg-zinc-800/60 ${t.text} transition-transform duration-300 group-hover:scale-110`}>
            <Icon size={14} />
          </span>
        )}
      </div>
      <div className="relative mt-2 text-[26px] font-bold leading-none tabular-nums tracking-tight text-zinc-50">{value}</div>
      {sub && <div className="relative mt-1.5 text-[11px] leading-snug text-zinc-500">{sub}</div>}
    </Tag>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-full border transition-all duration-300 disabled:opacity-40 ${
        checked
          ? "border-emerald-500/40 bg-emerald-500/90 shadow-[0_0_12px_rgba(16,185,129,0.25)]"
          : "border-zinc-700 bg-zinc-800"
      }`}
    >
      <span
        className={`inline-block h-[18px] w-[18px] rounded-full bg-white shadow transition-transform duration-300 ${
          checked ? "translate-x-[19px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}

export function Btn({
  children,
  variant = "ghost",
  size = "md",
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "subtle";
  size?: "sm" | "md" | "lg";
}) {
  const v = {
    primary:
      "border border-emerald-500/30 bg-gradient-to-b from-emerald-500 to-emerald-600 text-white shadow-lg shadow-emerald-900/30 hover:from-emerald-400 hover:to-emerald-500 hover:shadow-emerald-800/40",
    danger:
      "border border-rose-500/25 bg-rose-950/20 text-rose-300 hover:border-rose-500/50 hover:bg-rose-950/50 hover:text-rose-200",
    subtle: "border border-transparent bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700/70 hover:text-zinc-100",
    ghost:
      "border border-zinc-700/70 bg-zinc-900/40 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800/70 hover:text-zinc-100",
  }[variant];
  const s = {
    sm: "px-2.5 py-1 text-[11px] rounded-lg gap-1",
    md: "px-3.5 py-1.5 text-xs rounded-xl gap-1.5",
    lg: "px-4 py-2.5 text-[13px] rounded-xl gap-2",
  }[size];
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center font-medium transition-all duration-200 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 ${s} ${v} ${className}`}
    >
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = "zinc",
  className = "",
}: {
  children: React.ReactNode;
  tone?: "zinc" | "emerald" | "amber" | "rose" | "cyan" | "violet";
  className?: string;
}) {
  const t = {
    zinc: "border-zinc-700 bg-zinc-800/60 text-zinc-300",
    emerald: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
    amber: "border-amber-500/25 bg-amber-500/10 text-amber-300",
    rose: "border-rose-500/25 bg-rose-500/10 text-rose-300",
    cyan: "border-cyan-500/25 bg-cyan-500/10 text-cyan-300",
    violet: "border-violet-500/25 bg-violet-500/10 text-violet-300",
  }[tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${t} ${className}`}
    >
      {children}
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{label}</span>
      {children}
      {hint && <span className="block text-[10.5px] leading-relaxed text-zinc-600">{hint}</span>}
    </label>
  );
}

export function Empty({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/20 px-6 py-12 text-center text-xs text-zinc-600">
      <div className="grid h-11 w-11 place-items-center rounded-2xl bg-zinc-800/50 text-zinc-700">
        <Icon size={20} />
      </div>
      <div className="max-w-sm leading-relaxed">{children}</div>
    </div>
  );
}

export function CopyBtn({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
      className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-medium transition-all duration-200 active:scale-95 ${
        done
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
          : "border-zinc-700/70 bg-zinc-900/50 text-zinc-400 hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-100"
      }`}
    >
      {done ? "✓ Copied" : label}
    </button>
  );
}

export function Code({ children, copy = true }: { children: string; copy?: boolean }) {
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-xl border border-zinc-800 bg-black/50 p-4 font-mono text-[11px] leading-relaxed text-emerald-200/90">
        {children}
      </pre>
      {copy && (
        <div className="absolute right-2.5 top-2.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <CopyBtn text={children} />
        </div>
      )}
    </div>
  );
}

/** Segmented control for small filters / ranges. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  className = "",
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={`inline-flex items-center gap-0.5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-1 ${className}`}>
      {options.map(([v, l]) => (
        <button
          key={String(v)}
          onClick={() => onChange(v)}
          className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition-all duration-200 ${
            value === v
              ? "bg-gradient-to-b from-zinc-700 to-zinc-800 text-zinc-50 shadow-sm"
              : "text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-200"
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/** Select styled to match the dark theme. */
export function Select({ className = "", ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={`cursor-pointer rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-1.5 text-xs text-zinc-200 outline-none transition-all hover:border-zinc-700 focus:border-emerald-500/50 focus:ring-4 focus:ring-emerald-500/[0.08] ${className}`}
    />
  );
}

/** Simple animated progress bar. */
export function Meter({ value, tone = "emerald" }: { value: number; tone?: keyof typeof TONES }) {
  const bg = {
    emerald: "from-emerald-500 to-teal-400",
    cyan: "from-cyan-500 to-blue-400",
    violet: "from-violet-500 to-fuchsia-400",
    amber: "from-amber-500 to-orange-400",
    rose: "from-rose-500 to-pink-400",
  }[tone];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800/80">
      <div
        className={`h-full rounded-full bg-gradient-to-r ${bg} transition-[width] duration-700 ease-out`}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

/** Toast-ish message line. */
export function useFlash() {
  const [msg, setMsg] = useState<string | null>(null);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((m: string) => {
    setMsg(m);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => setMsg(null), 4000);
  }, []);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  const ok = msg?.startsWith("✓");
  const node = msg ? (
    <div className="fixed bottom-6 right-6 z-[60] animate-fade-in">
      <div
        role="status"
        className={`max-w-sm rounded-2xl border px-4 py-3 text-xs font-medium shadow-2xl shadow-black/50 backdrop-blur-xl ${
          ok ? "border-emerald-500/30 bg-emerald-950/85 text-emerald-200" : "border-rose-500/30 bg-rose-950/85 text-rose-200"
        }`}
      >
        {msg}
      </div>
    </div>
  ) : null;
  return { flash, node };
}

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(`/api/proxy${path}`, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b?.error?.message ?? b?.error ?? `HTTP ${r.status}`);
  return b as T;
}

/** Fetch JSON with optional polling. */
export function useJson<T>(path: string | null, intervalMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, [path]);
  useEffect(() => {
    reload();
    if (!intervalMs) return;
    const id = setInterval(reload, intervalMs);
    return () => clearInterval(id);
  }, [reload, intervalMs]);
  return { data, error, reload, setData };
}

export const fmt = {
  n: (v: number) => (v ?? 0).toLocaleString("en-US"),
  k: (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v ?? 0)),
  usd: (v: number) => (v >= 1 ? `$${v.toFixed(2)}` : `$${(v ?? 0).toFixed(4)}`),
  dur: (s: number) => {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(s % 60)}s`;
  },
  time: (iso: string) => new Date(iso).toLocaleTimeString("vi-VN", { hour12: false }),
};