"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { CatalogEntry } from "@/lib/catalog";
import { Btn, inputCls } from "@/components/ui";
import { describeTest, type TestResult } from "./ConnectCard";

// Re-exported for existing callers in this directory.
export { inputCls };

export function connectionBody(entry: CatalogEntry, accounts: { label: string; api_key: string; priority?: number }[]) {
  return {
    name: entry.id,
    format: entry.format,
    base_url: entry.baseUrl,
    models: entry.models.map((name) => ({ name })),
    accounts: accounts.map((a) => ({ priority: 50, weight: 1, ...a })),
    prefix: entry.prefix,
    display_name: entry.custom ? entry.name : undefined,
    merge: true,
  };
}

/**
 * Claude Code OAuth connect button.
 * Starts the PKCE flow (local loopback callback server), opens the authorize
 * URL in a new tab, then polls until the user completes authorization.
 */
export function ClaudeOAuth({ onDone }: { onDone: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function start() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/oauth/claude/start", { method: "POST" });
      const d = await r.json();
      if (!r.ok) {
        setMsg(`✗ ${d.error}`);
        setBusy(false);
        return;
      }
      window.open(d.url, "_blank", "noopener");
      setMsg("⏳ Đang chờ bạn đăng nhập trong tab mới…");

      const poll = async () => {
        const p = await fetch("/api/oauth/claude/poll").then((x) => x.json());
        if (p.status === "pending") {
          timer.current = setTimeout(poll, 2000);
        } else if (p.status === "connected") {
          setMsg(`✓ Đã kết nối ${p.label}${p.email ? ` (${p.email})` : ""}`);
          setBusy(false);
          onDone();
        } else {
          setMsg(`✗ ${p.error ?? p.status}`);
          setBusy(false);
        }
      };
      timer.current = setTimeout(poll, 2500);
    } catch (e) {
      setMsg(`✗ ${String(e)}`);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <button
        onClick={start}
        disabled={busy}
        className="w-full rounded-xl border border-[#d97757]/40 bg-gradient-to-b from-[#d97757] to-[#c9684b] px-4 py-2.5 text-xs font-semibold text-white shadow-lg shadow-[#d97757]/20 transition-all hover:from-[#e08362] hover:to-[#d97757] active:scale-[0.98] disabled:opacity-40"
      >
        {busy ? "⏳ Đang chờ đăng nhập…" : "🔑 Đăng nhập Claude Code"}
      </button>
      {msg && <p className="animate-fade-in text-xs text-zinc-400">{msg}</p>}
      <p className="text-[11px] leading-relaxed text-zinc-500">
        Mở tab mới để đăng nhập claude.ai và cấp quyền. Token sẽ tự lưu và router
        dùng Claude Code qua OAuth — tự làm mới token khi hết hạn.
      </p>
    </div>
  );
}

export function GithubDevice({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState<{ user_code: string; verification_uri: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function start() {
    setMsg(null);
    const r = await fetch("/api/oauth/github/start", { method: "POST" });
    const d = await r.json();
    if (!r.ok) return setMsg(`✗ ${d.error}`);
    setCode(d);
    window.open(d.verification_uri, "_blank", "noopener");
    const poll = async (interval: number) => {
      const p = await fetch("/api/oauth/github/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flow: d.flow }),
      }).then((x) => x.json());
      if (p.status === "pending") {
        timer.current = setTimeout(() => poll(p.interval ?? interval), (p.interval ?? interval) * 1000);
      } else if (p.status === "connected") {
        setCode(null);
        setMsg(`✓ Đã kết nối ${p.label} — ${p.models?.length ?? 0} model Copilot`);
        onDone();
      } else {
        setCode(null);
        setMsg(`✗ ${p.error ?? p.status}`);
      }
    };
    timer.current = setTimeout(() => poll(d.interval), d.interval * 1000);
  }

  return (
    <div className="space-y-3">
      {!code ? (
        <button
          onClick={start}
          className="w-full rounded-xl border border-violet-500/30 bg-gradient-to-b from-violet-500 to-violet-600 px-4 py-2.5 text-xs font-semibold text-white shadow-lg shadow-violet-900/30 transition-all hover:from-violet-400 hover:to-violet-500 active:scale-[0.98]"
        >
          + Thêm tài khoản GitHub (device login)
        </button>
      ) : (
        <div className="animate-fade-in space-y-2 rounded-2xl border border-violet-500/30 bg-violet-950/25 p-4 text-center">
          <p className="text-[11px] text-zinc-400">Nhập mã này tại</p>
          <a href={code.verification_uri} target="_blank" rel="noreferrer" className="text-xs text-violet-300 underline">
            {code.verification_uri}
          </a>
          <p className="my-2 select-all font-mono text-2xl font-bold tracking-widest text-white">{code.user_code}</p>
          <p className="flex items-center justify-center gap-1.5 text-[11px] text-zinc-500">
            <Loader2 size={11} className="animate-spin" />
            Đang chờ bạn xác nhận…
          </p>
        </div>
      )}
      {msg && (
        <p className={`animate-fade-in text-xs font-medium ${msg.startsWith("✓") ? "text-emerald-400" : "text-rose-400"}`}>{msg}</p>
      )}
      <p className="text-[11px] leading-relaxed text-zinc-500">
        Cần tài khoản GitHub có Copilot (gói Free cũng được — bật tại github.com/settings/copilot). Token tự làm mới mỗi phút.
      </p>
    </div>
  );
}

export function KeyForm({ entry, onDone }: { entry: CatalogEntry; onDone: () => void }) {
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [priority, setPriority] = useState("50");
  const [model, setModel] = useState(entry.models[0] ?? "");
  const [result, setResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function test() {
    setBusy(true);
    setResult(null);
    const r = await fetch("/api/proxy/admin/connections/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connection: connectionBody(entry, []), api_key: key.trim(), model }),
    });
    setBusy(false);
    setResult((await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as TestResult);
  }

  async function save() {
    setBusy(true);
    const l = label.trim() || `${entry.id}-${Date.now().toString(36).slice(-5)}`;
    const r = await fetch("/api/proxy/admin/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(connectionBody(entry, [{ label: l, api_key: key.trim(), priority: Number(priority) || 50 }])),
    });
    setBusy(false);
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      setResult({ ok: false, error: b.error?.message ?? b.error ?? `HTTP ${r.status}` });
      return;
    }
    setKey("");
    setLabel("");
    setResult(null);
    onDone();
  }

  return (
    <div className="space-y-2">
      {entry.keyUrl && (
        <p className="text-[11px] text-zinc-500">
          {entry.keyHint ?? "API key"} ·{" "}
          <a href={entry.keyUrl} target="_blank" rel="noreferrer" className="text-emerald-400 hover:underline">Lấy key ↗</a>
        </p>
      )}
      <input type="password" autoComplete="off" placeholder="API key" value={key} onChange={(e) => setKey(e.target.value)} className={`${inputCls} font-mono`} />
      <div className="grid grid-cols-3 gap-2">
        <input placeholder="label (tuỳ chọn)" value={label} onChange={(e) => setLabel(e.target.value)} className={`${inputCls} col-span-2`} />
        <input type="number" title="priority (cao = dùng trước)" value={priority} onChange={(e) => setPriority(e.target.value)} className={inputCls} />
      </div>
      {entry.models.length > 0 && (
        <select value={model} onChange={(e) => setModel(e.target.value)} className={inputCls}>
          {entry.models.map((m) => <option key={m}>{m}</option>)}
        </select>
      )}
      <div className="flex gap-2">
        <Btn onClick={test} disabled={busy || !key.trim()} className="flex-1">
          {busy ? "…" : "Kiểm tra"}
        </Btn>
        <Btn
          variant="primary"
          onClick={save}
          disabled={busy || !result?.ok}
          title={result?.ok ? "" : "Kiểm tra thành công trước"}
          className="flex-1"
        >
          Connect
        </Btn>
      </div>
      {result && (
        <p
          className={`animate-fade-in break-all rounded-xl border px-3 py-2 font-mono text-[11px] ${
            result.ok ? "border-emerald-500/25 bg-emerald-950/20 text-emerald-300" : "border-rose-500/25 bg-rose-950/20 text-rose-300"
          }`}
        >
          {describeTest(result)}
        </p>
      )}
    </div>
  );
}
