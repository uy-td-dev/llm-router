"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Database, Loader2, Lock, User, UserPlus } from "lucide-react";

export default function RegisterForm() {
  const router = useRouter();
  const [form, setForm] = useState({ username: "", password: "", confirm: "", displayName: "" });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (form.password !== form.confirm) {
      setError("Password không khớp");
      return;
    }
    if (form.password.length < 8) {
      setError("Password phải có ít nhất 8 ký tự");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: form.username,
          password: form.password,
          displayName: form.displayName || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Lỗi" }));
        setError(data.error || "Đăng ký thất bại");
        return;
      }
      router.push("/dash");
      router.refresh();
    } catch {
      setError("Không kết nối được tới server");
    } finally {
      setLoading(false);
    }
  }

  const fields = [
    { key: "username" as const, label: "Username", type: "text", auto: "username", req: true, icon: User, ph: "yourname" },
    { key: "displayName" as const, label: "Tên hiển thị (tùy chọn)", type: "text", auto: "name", req: false, icon: User, ph: "" },
    { key: "password" as const, label: "Password (tối thiểu 8 ký tự)", type: "password", auto: "new-password", req: true, icon: Lock, ph: "••••••••" },
    { key: "confirm" as const, label: "Xác nhận password", type: "password", auto: "new-password", req: true, icon: Lock, ph: "••••••••" },
  ];

  return (
    <div className="noise-bg relative flex min-h-screen items-center justify-center overflow-hidden bg-zinc-950 px-4 py-10">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-40 -top-40 h-[600px] w-[600px] rounded-full bg-emerald-500/[0.06] blur-[140px]" />
        <div className="absolute -bottom-48 -right-32 h-[500px] w-[500px] rounded-full bg-cyan-500/[0.05] blur-[130px]" />
      </div>
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
        className="animate-fade-in relative z-10 w-full max-w-[400px] space-y-5 rounded-3xl border border-zinc-800/70 bg-zinc-900/50 p-8 shadow-2xl shadow-black/50 backdrop-blur-xl"
      >
        <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-emerald-500/40 to-transparent" />

        <div className="text-center">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-emerald-400 via-teal-400 to-cyan-500 shadow-lg shadow-emerald-500/25">
            <UserPlus size={26} strokeWidth={2.2} className="text-zinc-950" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">Tạo tài khoản</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-zinc-500">
            Đăng ký tự do — vai trò <code className="rounded bg-zinc-800/60 px-1.5 py-0.5 font-mono text-[11px] text-zinc-400">user</code>
          </p>
        </div>

        <div className="space-y-4">
          {fields.map(({ key, label, type, auto, req, icon: Icon, ph }) => (
            <div key={key} className="space-y-1.5">
              <label className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{label}</label>
              <div className="relative">
                <Icon size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
                <input
                  type={type}
                  placeholder={ph}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950/70 py-2.5 pl-10 pr-3.5 text-[13px] text-zinc-100 outline-none transition-all placeholder:text-zinc-600 hover:border-zinc-700 focus:border-emerald-500/50 focus:ring-4 focus:ring-emerald-500/[0.08]"
                  value={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  autoComplete={auto}
                  required={req}
                />
              </div>
            </div>
          ))}
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
              Đang tạo...
            </>
          ) : (
            <>
              <UserPlus size={16} />
              Đăng ký
            </>
          )}
        </button>

        <p className="text-center text-[11px] text-zinc-600">
          Đã có tài khoản?{" "}
          <a href="/login" className="font-medium text-emerald-400 transition-colors hover:text-emerald-300 hover:underline">
            Đăng nhập
          </a>
        </p>
      </form>
    </div>
  );
}