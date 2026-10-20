"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Download, Pause, Play, ScrollText, Search, Trash2 } from "lucide-react";
import { Btn, PageHeader, api, inputCls } from "@/components/ui";

interface Line {
  id: number;
  ts: string;
  level: string;
  target: string;
  message: string;
}

const LEVEL_CLS: Record<string, string> = {
  ERROR: "text-rose-400",
  WARN: "text-amber-300",
  INFO: "text-emerald-400",
};
const MAX = 3000;

export default function ConsoleClient() {
  const [lines, setLines] = useState<Line[]>([]);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [q, setQ] = useState("");
  const [levels, setLevels] = useState<Record<string, boolean>>({ INFO: true, WARN: true, ERROR: true });
  const last = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (paused) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await api<{ last_id: number; lines: Line[] }>(`/admin/logs?after=${last.current}&limit=1000`);
        if (!alive) return;
        if (r.last_id < last.current) last.current = 0; // router restarted
        if (r.lines.length) {
          last.current = r.lines[r.lines.length - 1].id;
          setLines((prev) => [...prev, ...r.lines].slice(-MAX));
        }
      } catch {
        /* router offline: keep polling */
      }
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [paused]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);

  const shown = lines.filter((l) => levels[l.level] !== false && (!q || `${l.target} ${l.message}`.toLowerCase().includes(q.toLowerCase())));

  function download() {
    const text = shown.map((l) => `${l.ts} ${l.level.padEnd(5)} ${l.target}: ${l.message}`).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = `llm-router-${new Date().toISOString().slice(0, 19)}.log`;
    a.click();
  }

  async function clear() {
    await api("/admin/logs", { method: "DELETE" }).catch(() => {});
    setLines([]);
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <PageHeader
        icon={ScrollText}
        title="Console Log"
        desc="Log realtime của router: routing, fallback, cooldown 429, lỗi upstream, cache… (buffer 2000 dòng gần nhất trong bộ nhớ)."
        actions={
          <>
            <Btn onClick={() => setPaused(!paused)}>{paused ? <><Play size={13} /> Tiếp tục</> : <><Pause size={13} /> Tạm dừng</>}</Btn>
            <Btn onClick={download}>
              <Download size={13} /> Tải về
            </Btn>
            <Btn variant="danger" onClick={clear}>
              <Trash2 size={13} /> Xoá
            </Btn>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Lọc theo nội dung…" className={`${inputCls} pl-9`} />
        </div>
        {Object.keys(levels).map((lv) => (
          <button
            key={lv}
            onClick={() => setLevels({ ...levels, [lv]: !levels[lv] })}
            className={`rounded-xl border px-3 py-1.5 text-[11px] font-semibold tracking-wide transition-all ${
              levels[lv] ? `border-zinc-700/70 bg-zinc-900/60 ${LEVEL_CLS[lv]}` : "border-zinc-800/50 text-zinc-600 hover:text-zinc-400"
            }`}
          >
            {lv}
          </button>
        ))}
        <span className="ml-auto text-[11px] tabular-nums text-zinc-600">
          {shown.length}/{lines.length} dòng
        </span>
        <button
          onClick={() => setFollow(!follow)}
          className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[11px] font-medium transition-all ${
            follow ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-zinc-800 text-zinc-500 hover:border-zinc-700"
          }`}
        >
          <ArrowDownToLine size={12} /> Tự cuộn
        </button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-zinc-800/70 bg-black/70 shadow-2xl shadow-black/30">
        <div className="flex items-center gap-1.5 border-b border-zinc-800/60 bg-zinc-900/70 px-3.5 py-2.5 backdrop-blur">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-500/70 shadow-[0_0_4px_rgba(244,63,94,0.4)]" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70 shadow-[0_0_4px_rgba(251,191,36,0.4)]" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70 shadow-[0_0_4px_rgba(16,185,129,0.4)]" />
          <span className="ml-2.5 font-mono text-[10px] text-zinc-500">llm-router — {paused ? "paused" : "live"}</span>
          {!paused && <span className="ml-1 h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />}
        </div>
        <div
          ref={box}
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (atBottom !== follow) setFollow(atBottom);
          }}
          className="h-[calc(100%-2.25rem)] overflow-auto p-3 font-mono text-[11px] leading-5"
        >
          {shown.map((l) => (
            <div key={l.id} className="flex gap-2 whitespace-pre-wrap break-all rounded-lg px-1.5 py-0.5 transition-colors hover:bg-white/[0.04]">
              <span className="shrink-0 tabular-nums text-zinc-600">{new Date(l.ts).toLocaleTimeString("vi-VN", { hour12: false })}</span>
              <span className={`w-11 shrink-0 font-semibold ${LEVEL_CLS[l.level] ?? "text-zinc-400"}`}>{l.level}</span>
              <span className="shrink-0 text-cyan-500/70">{l.target}</span>
              <span className="text-zinc-300">{l.message}</span>
            </div>
          ))}
          {!shown.length && (
            <div className="flex flex-col items-center gap-2 py-12 text-zinc-600">
              <ScrollText size={22} className="text-zinc-700" />
              Chưa có log…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
