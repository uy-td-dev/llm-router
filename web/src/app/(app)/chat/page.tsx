"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Bot, Loader2, Send, Trash2 } from "lucide-react";
import { Btn, PageHeader, Select } from "@/components/ui";

export default function ChatPage() {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [meta, setMeta] = useState<string | null>(null);
  const [history, setHistory] = useState<{ role: string; content: string }[]>([]);
  const outRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/proxy/v1/models");
      if (!res.ok) return;
      const data = await res.json();
      const ids: string[] = data.data?.map((m: { id: string }) => m.id) ?? [];
      setModels(ids);
      setModel(ids.find((m) => !m.includes("embedding")) ?? ids[0] ?? "");
    })();
  }, []);

  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
  }, [output]);

  async function send() {
    if (!input.trim() || streaming || !model) return;
    const userMsg = { role: "user", content: input.trim() };
    const msgs = [...history, userMsg];
    setHistory([...history, userMsg, { role: "assistant", content: "" }]);
    setInput("");
    setOutput("");
    setStreaming(true);
    setMeta(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: msgs, stream: true }),
      });

      if (!res.ok) {
        const text = await res.text();
        setMeta(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        setStreaming(false);
        return;
      }

      const isSSE = res.headers.get("content-type")?.includes("event-stream");
      if (!isSSE) {
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content ?? JSON.stringify(data);
        setOutput(content);
        setHistory((h) => {
          const copy = [...h];
          copy[copy.length - 1] = { role: "assistant", content };
          return copy;
        });
        setStreaming(false);
        return;
      }

      // SSE: accumulate delta content
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const chunk = JSON.parse(payload);
            const delta = chunk.choices?.[0]?.delta?.content ?? "";
            acc += delta;
            setOutput(acc);
          } catch {
            /* partial line */
          }
        }
      }
      setHistory((h) => {
        const copy = [...h];
        copy[copy.length - 1] = { role: "assistant", content: acc };
        return copy;
      });
    } catch (e) {
      setMeta(`Lỗi: ${String(e)}`);
    }
    setStreaming(false);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        icon={Bot}
        title="Chat Playground"
        desc="Gửi thử request trực tiếp qua router để kiểm tra model, provider và stream."
        actions={
          <>
            <Select value={model} onChange={(e) => setModel(e.target.value)}>
              {models
                .filter((m) => !m.includes("embedding"))
                .map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
            </Select>
            {history.length > 0 && (
              <Btn onClick={() => { setHistory([]); setOutput(""); setMeta(null); }}>
                <Trash2 size={13} />
                Xoá hội thoại
              </Btn>
            )}
          </>
        }
      />

      <div
        ref={outRef}
        className="h-[28rem] space-y-3 overflow-y-auto rounded-2xl border border-zinc-800/70 bg-zinc-900/30 p-4"
      >
        {!history.length && !output && (
          <div className="flex h-full flex-col items-center justify-center gap-2.5 text-zinc-600">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-zinc-800/40 text-zinc-700">
              <Bot size={22} />
            </div>
            <span className="text-xs">Trả lời sẽ hiện ở đây (stream trực tiếp qua llm-router)…</span>
          </div>
        )}

        {history.map((m, i) => {
          const isLast = i === history.length - 1;
          const content = m.role === "assistant" && isLast && streaming ? output : m.content;
          if (m.role === "assistant" && !content && streaming) {
            return (
              <div key={i} className="flex items-center gap-2 text-xs text-zinc-500">
                <Loader2 size={13} className="animate-spin text-emerald-400" />
                Đang suy nghĩ…
              </div>
            );
          }
          return (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] animate-fade-in whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-[13px] leading-relaxed ${
                  m.role === "user"
                    ? "border border-emerald-500/25 bg-emerald-500/10 text-zinc-100"
                    : "border border-zinc-800/70 bg-zinc-900/60 font-mono text-[12px] text-zinc-200"
                }`}
              >
                {content || <span className="text-zinc-600">—</span>}
              </div>
            </div>
          );
        })}
      </div>

      {meta && (
        <p className="animate-fade-in flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-950/20 px-3.5 py-2.5 text-xs text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="break-all">{meta}</span>
        </p>
      )}

      <div className="flex gap-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder="Nhập tin nhắn… (Enter gửi, Shift+Enter xuống dòng)"
          className="flex-1 resize-none rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-[13px] text-zinc-100 outline-none transition-all placeholder:text-zinc-600 hover:border-zinc-700 focus:border-emerald-500/50 focus:ring-4 focus:ring-emerald-500/[0.08]"
        />
        <Btn variant="primary" size="lg" onClick={send} disabled={streaming || !input.trim()} className="px-6">
          {streaming ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          {streaming ? "Đang gửi" : "Gửi"}
        </Btn>
      </div>
    </div>
  );
}
