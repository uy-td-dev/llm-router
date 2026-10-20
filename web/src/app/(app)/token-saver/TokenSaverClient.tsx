"use client";

import { useEffect, useState } from "react";
import { Eraser, FlaskConical, History, PiggyBank, Rows3, Save, Scissors, Sparkles } from "lucide-react";
import { Btn, Field, PageHeader, Panel, Stat, Toggle, api, fmt, inputCls, useFlash, useJson } from "@/components/ui";

interface Settings {
  enabled: boolean;
  max_history: number;
  max_message_chars: number;
  trim_whitespace: boolean;
  dedupe: boolean;
}
interface Counters {
  saved_tokens_total: number;
  saver_runs: number;
}
interface Preview {
  before_tokens: number;
  after_tokens: number;
  saved_tokens: number;
  messages: { role: string; content: string }[];
}

const SAMPLE = JSON.stringify(
  [
    { role: "system", content: "Bạn là trợ lý lập trình." },
    { role: "user", content: "Câu hỏi 1\n\n\n\n   " },
    { role: "assistant", content: "Trả lời 1 ".repeat(400) },
    { role: "user", content: "Câu hỏi 2" },
    { role: "user", content: "Câu hỏi 2" },
    { role: "assistant", content: "Trả lời 2" },
    { role: "user", content: "Câu hỏi mới nhất — không bao giờ bị cắt" },
  ],
  null,
  2,
);

export default function TokenSaverClient({ isAdmin }: { isAdmin: boolean }) {
  const { flash, node } = useFlash();
  const { data, reload } = useJson<{ settings: Settings; counters: Counters }>("/admin/token-saver", 15000);
  const [s, setS] = useState<Settings | null>(null);
  const [sample, setSample] = useState(SAMPLE);
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    if (data && !s) setS(data.settings);
  }, [data, s]);

  async function save(next = s) {
    if (!next) return;
    try {
      await api("/admin/token-saver", { body: next });
      flash("✓ Đã lưu Token Saver");
      reload();
    } catch (e) {
      flash(`✗ ${(e as Error).message}`);
    }
  }

  async function runPreview() {
    if (!s) return;
    try {
      const messages = JSON.parse(sample);
      setPreview(await api<Preview>("/admin/token-saver/preview", { body: { settings: { ...s, enabled: true }, messages } }));
    } catch (e) {
      flash(`✗ ${(e as Error).message}`);
    }
  }

  const c = data?.counters;
  const pct = preview && preview.before_tokens ? (preview.saved_tokens / preview.before_tokens) * 100 : 0;

  return (
    <div className="space-y-6">
      {node}
      <PageHeader
        icon={PiggyBank}
        title="Token Saver"
        desc="Rút gọn request trước khi gửi lên upstream: bỏ khoảng trắng thừa, gộp tin nhắn trùng, giới hạn độ dài lịch sử hội thoại và cắt các tin nhắn cũ quá dài. Tin nhắn user cuối cùng và system prompt luôn được giữ nguyên."
        actions={
          s && (
            <div className="flex items-center gap-3 rounded-2xl border border-zinc-800/70 bg-zinc-900/50 px-4 py-2.5">
              <span className="text-xs font-medium text-zinc-300">{s.enabled ? "Đang bật" : "Đang tắt"}</span>
              <Toggle
                checked={s.enabled}
                disabled={!isAdmin}
                onChange={(v) => {
                  const next = { ...s, enabled: v };
                  setS(next);
                  save(next);
                }}
              />
            </div>
          )
        }
      />

      <div className="stagger-children grid grid-cols-2 gap-3.5 lg:grid-cols-3">
        <Stat label="Token đã tiết kiệm" value={fmt.k(c?.saved_tokens_total ?? 0)} icon={Sparkles} sub="ước tính ~4 ký tự/token" />
        <Stat label="Request đã xử lý" value={fmt.n(c?.saver_runs ?? 0)} icon={Rows3} tone="cyan" />
        <Stat label="TB / request" value={c?.saver_runs ? fmt.k(Math.round(c.saved_tokens_total / c.saver_runs)) : "0"} icon={Scissors} tone="violet" />
      </div>

      {s && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Quy tắc" icon={Scissors}>
            <div className="space-y-4">
              <Rule icon={Eraser} title="Gọn khoảng trắng" desc="Xoá khoảng trắng cuối dòng, gộp nhiều dòng trống liên tiếp.">
                <Toggle checked={s.trim_whitespace} disabled={!isAdmin} onChange={(v) => setS({ ...s, trim_whitespace: v })} />
              </Rule>
              <Rule icon={Rows3} title="Bỏ tin nhắn trùng" desc="Loại tin nhắn giống hệt tin ngay trước nó (cùng role).">
                <Toggle checked={s.dedupe} disabled={!isAdmin} onChange={(v) => setS({ ...s, dedupe: v })} />
              </Rule>
              <Field label="Giữ tối đa N tin nhắn gần nhất (không tính system)" hint="0 = không giới hạn">
                <input type="number" min={0} value={s.max_history} disabled={!isAdmin} onChange={(e) => setS({ ...s, max_history: Number(e.target.value) })} className={inputCls} />
              </Field>
              <Field label="Cắt tin nhắn cũ dài hơn (ký tự)" hint="0 = tắt. Không áp dụng cho tin nhắn user cuối và system.">
                <input type="number" min={0} value={s.max_message_chars} disabled={!isAdmin} onChange={(e) => setS({ ...s, max_message_chars: Number(e.target.value) })} className={inputCls} />
              </Field>
              {isAdmin && (
                <Btn variant="primary" onClick={() => save()}>
                  <Save size={13} /> Lưu quy tắc
                </Btn>
              )}
            </div>
          </Panel>

          <Panel
            title="Thử nghiệm"
            icon={FlaskConical}
            actions={
              <Btn onClick={runPreview}>
                <FlaskConical size={13} /> Chạy thử
              </Btn>
            }
          >
            <textarea value={sample} onChange={(e) => setSample(e.target.value)} rows={10} className={`${inputCls} font-mono text-[11px]`} />
            {preview && (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-zinc-950/60 p-2.5">
                    <div className="text-[10px] text-zinc-500">Trước</div>
                    <div className="text-lg font-semibold tabular-nums">{preview.before_tokens}</div>
                  </div>
                  <div className="rounded-xl bg-zinc-950/60 p-2.5">
                    <div className="text-[10px] text-zinc-500">Sau</div>
                    <div className="text-lg font-semibold tabular-nums">{preview.after_tokens}</div>
                  </div>
                  <div className="rounded-xl bg-emerald-500/10 p-2.5">
                    <div className="text-[10px] text-emerald-400/80">Tiết kiệm</div>
                    <div className="text-lg font-semibold tabular-nums text-emerald-300">{pct.toFixed(0)}%</div>
                  </div>
                </div>
                <div className="max-h-56 space-y-1.5 overflow-y-auto">
                  {preview.messages.map((m, i) => (
                    <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-2.5 py-1.5">
                      <span className="mr-2 text-[10px] font-semibold uppercase text-zinc-500">{m.role}</span>
                      <span className="whitespace-pre-wrap break-words text-[11px] text-zinc-300">
                        {typeof m.content === "string" ? (m.content.length > 300 ? m.content.slice(0, 300) + "…" : m.content) : JSON.stringify(m.content)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {!preview && (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-600">
                <History size={12} /> Dán mảng messages (OpenAI format) rồi bấm Chạy thử. Chế độ xem trước không tính vào thống kê.
              </p>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

function Rule({ icon: Icon, title, desc, children }: { icon: typeof Eraser; title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-zinc-800/70 bg-zinc-900/30 p-3.5 transition-colors hover:border-zinc-700/70">
      <div className="flex items-start gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-zinc-800/60 text-zinc-400">
          <Icon size={15} />
        </span>
        <div>
          <div className="text-xs font-semibold text-zinc-200">{title}</div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">{desc}</div>
        </div>
      </div>
      {children}
    </div>
  );
}
