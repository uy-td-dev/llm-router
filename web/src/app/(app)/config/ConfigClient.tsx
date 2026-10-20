"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, Save, Settings2 } from "lucide-react";
import { Btn, Panel } from "@/components/ui";

export default function ConfigClient({ role }: { role: string }) {
  const [text, setText] = useState<string>("");
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/proxy/admin/config");
    if (!res.ok) {
      setErr(`Không tải được config (${res.status})`);
      return;
    }
    setErr(null);
    setText(JSON.stringify(await res.json(), null, 2));
  }, []);

  useEffect(() => {
    if (role === "admin") load();
  }, [load, role]);

  async function save() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setErr(`JSON không hợp lệ: ${(e as Error).message}`);
      return;
    }
    setBusy(true);
    const res = await fetch("/api/proxy/admin/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsed),
    });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setErr(`Lưu thất bại (${res.status}): ${body.error ?? "không rõ"}`);
      return;
    }
    setErr(null);
    setNote("Đã ghi config/default.yaml (backup .bak) — restart llm-router để áp dụng.");
  }

  if (role !== "admin") {
    return <p className="text-sm text-zinc-500">Chỉ admin xem được trang này.</p>;
  }

  return (
    <Panel
      title="config/default.yaml (JSON)"
      icon={Settings2}
      actions={
        <>
          <Btn onClick={load}>
            <RefreshCw size={13} />
            Tải lại
          </Btn>
          <Btn variant="primary" onClick={save} disabled={busy}>
            <Save size={13} />
            Lưu config
          </Btn>
        </>
      }
    >
      <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">
        Secrets trả về dạng <code className="rounded bg-amber-500/10 px-1 py-0.5 font-mono text-amber-400">__SAVED__</code> — giữ nguyên để giữ
        giá trị cũ; <code className="rounded bg-zinc-800/60 px-1 py-0.5 font-mono">keys</code>/<code className="rounded bg-zinc-800/60 px-1 py-0.5 font-mono">security</code> bỏ thay đổi (quản lý ở trang Keys).
      </p>

      {note && (
        <p className="animate-fade-in mb-3 flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-950/20 px-3.5 py-2.5 text-xs text-emerald-300">
          <CheckCircle2 size={14} className="shrink-0" />
          {note}
        </p>
      )}
      {err && (
        <p className="animate-fade-in mb-3 flex items-center gap-2 rounded-xl border border-rose-500/25 bg-rose-950/20 px-3.5 py-2.5 text-xs text-rose-300">
          <AlertTriangle size={14} className="shrink-0" />
          {err}
        </p>
      )}

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={28}
        className="w-full rounded-xl border border-zinc-800/70 bg-black/50 p-4 font-mono text-xs leading-relaxed text-zinc-300 outline-none transition-all focus:border-emerald-500/50 focus:ring-4 focus:ring-emerald-500/[0.08]"
      />
    </Panel>
  );
}
