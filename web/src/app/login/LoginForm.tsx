"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Database, Loader2, Lock, User } from "lucide-react";

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Lỗi" }));
        setError(data.error || "Đăng nhập thất bại");
        return;
      }
      const data = await res.json().catch(() => null);
      const role: string | undefined = data?.user?.role;
      const home = role === "admin" ? "/dash" : "/endpoint";
      router.push(params.get("next") || home);
      router.refresh();
    } catch {
      setError("Không kết nối được tới server");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="noise-bg relative flex min-h-screen items-center justify-center overflow-hidden bg-zinc-950 px-4">
      {/* Ambient background */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-40 -top-40 h-[600px] w-[600px] rounded-full bg-emerald-500/[0.06] blur-[140px]" />
        <div className="absolute -bottom-48 -right-32 h-[500px] w-[500px] rounded-full bg-cyan-500/[0.05] blur-[130px]" />
        <div className="absolute left-1/2 top-1/2 h-[400px] w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-500/[0.03] blur-[120px]" />
      </div>

      {/* Grid pattern */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.035]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />

      <form
        onSubmit={submit}
        className="animate-fade-in relative z-10 w-full max-w-[400px] space-y-6 rounded-3xl border border-zinc-800/70 bg-zinc-900/50 p-8 shadow-2xl shadow-black/50 backdrop-blur-xl"
      >
        {/* Top gradient line */}
        <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-emerald-500/40 to-transparent" />

        <div className="text-center">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-emerald-400 via-teal-400 to-cyan-500 shadow-lg shadow-emerald-500/25">
            <Database size={26} strokeWidth={2.2} className="text-zinc-950" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">LLM Router</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-zinc-500">
            Đăng nhập để quản lý providers, keys & theo dõi usage
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Username</label>
            <div className="relative">
              <User size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
              <input
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/70 py-2.5 pl-10 pr-3.5 text-[13px] text-zinc-100 outline-none transition-all placeholder:text-zinc-600 hover:border-zinc-700 focus:border-emerald-500/50 focus:ring-4 focus:ring-emerald-500/[0.08]"
                placeholder="admin"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Password</label>
            <div className="relative">
              <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
              <input
                type="password"
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/70 py-2.5 pl-10 pr-3.5 text-[13px] text-zinc-100 outline-none transition-all placeholder:text-zinc-600 hover:border-zinc-700 focus:border-emerald-500/50 focus:ring-4 focus:ring-emerald-500/[0.08]"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-rose-500/25 bg-rose-950/30 px-3.5 py-2.5 text-xs text-rose-300 animate-fade-in">
            <AlertTriangle size={14} className="shrink-0" />
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl border border-emerald-500/30 bg-gradient-to-b from-emerald-500 to-emerald-600 py-3 text-[14px] font-semibold text-white shadow-lg shadow-emerald-900/30 transition-all duration-200 hover:from-emerald-400 hover:to-emerald-500 hover:shadow-emerald-800/40 active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
        >
          <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
          {loading ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Đang đăng nhập...
            </>
          ) : (
            "Đăng nhập"
          )}
        </button>

        <div className="flex items-center justify-between text-[11px] text-zinc-600">
          <span>
            Chưa có tài khoản?{" "}
            <a href="/register" className="font-medium text-emerald-400 transition-colors hover:text-emerald-300 hover:underline">
              Đăng ký
            </a>
          </span>
          <code className="rounded-md bg-zinc-800/60 px-2 py-0.5 font-mono text-[10px] text-zinc-500">admin / admin123</code>
        </div>
      </form>
    </div>
  );
}