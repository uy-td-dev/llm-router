"use client";

import { useState } from "react";
import { Pencil, Plus, Puzzle, Save, Sparkles, Trash2, X, Zap } from "lucide-react";
import { Badge, Btn, Empty, Field, PageHeader, Panel, Toggle, api, inputCls, useFlash, useJson } from "@/components/ui";

interface Skill {
  name: string;
  description: string;
  prompt: string;
  enabled: boolean;
  auto: boolean;
}

const TEMPLATES: Skill[] = [
  { name: "vi", description: "Luôn trả lời bằng tiếng Việt", prompt: "Luôn trả lời bằng tiếng Việt, ngắn gọn, rõ ràng. Giữ nguyên thuật ngữ kỹ thuật tiếng Anh khi cần.", enabled: true, auto: false },
  { name: "review", description: "Code review chi tiết", prompt: "Bạn là senior engineer. Review đoạn code người dùng gửi: chỉ ra bug, lỗ hổng bảo mật, vấn đề hiệu năng và khả năng bảo trì. Trình bày theo mức độ nghiêm trọng, kèm đề xuất sửa cụ thể.", enabled: true, auto: false },
  { name: "concise", description: "Trả lời cực ngắn", prompt: "Trả lời ngắn nhất có thể. Không giải thích trừ khi được hỏi. Không lặp lại câu hỏi.", enabled: true, auto: false },
  { name: "commit", description: "Viết commit message", prompt: "Viết commit message theo Conventional Commits từ diff người dùng gửi. Dòng tiêu đề ≤ 72 ký tự, thân giải thích lý do thay đổi.", enabled: true, auto: false },
  { name: "sql", description: "Chuyên gia SQL", prompt: "Bạn là chuyên gia PostgreSQL. Viết truy vấn tối ưu, giải thích index cần thiết và cảnh báo các truy vấn có thể khoá bảng.", enabled: true, auto: false },
];

const blank: Skill = { name: "", description: "", prompt: "", enabled: true, auto: false };

export default function SkillsClient({ isAdmin }: { isAdmin: boolean }) {
  const { flash, node } = useFlash();
  const { data, reload } = useJson<{ skills: Skill[]; counters: { skill_runs: number } }>("/admin/skills");
  const [edit, setEdit] = useState<{ skill: Skill; isNew: boolean } | null>(null);
  const skills = data?.skills ?? [];

  async function save(s: Skill) {
    try {
      await api("/admin/skills", { body: s });
      flash(`✓ Đã lưu skill /${s.name}`);
      setEdit(null);
      reload();
    } catch (e) {
      flash(`✗ ${(e as Error).message}`);
    }
  }

  async function del(name: string) {
    if (!confirm(`Xoá skill ${name}?`)) return;
    try {
      await api(`/admin/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
      reload();
    } catch (e) {
      flash(`✗ ${(e as Error).message}`);
    }
  }

  return (
    <div className="space-y-6">
      {node}
      <PageHeader
        icon={Puzzle}
        title="Skills"
        desc={
          <>
            Các system prompt dùng lại được. Gõ <code className="text-emerald-300">/tên-skill nội dung…</code> ở đầu tin nhắn để kích hoạt, hoặc bật <b>Auto</b> để skill tự chèn vào mọi request đi qua router. Dùng được với mọi client.
          </>
        }
        actions={
          isAdmin && (
            <Btn variant="primary" onClick={() => setEdit({ skill: blank, isNew: true })}>
              <Plus size={13} /> Tạo skill
            </Btn>
          )
        }
      />

      <div className="flex items-center gap-4 text-xs text-zinc-500">
        <span className="flex items-center gap-1.5">
          <Zap size={13} className="text-amber-400" /> Đã kích hoạt <b className="text-zinc-200">{data?.counters.skill_runs ?? 0}</b> lần
        </span>
        <span>
          <b className="text-zinc-200">{skills.filter((s) => s.enabled).length}</b>/{skills.length} đang bật
        </span>
      </div>

      {skills.length ? (
        <div className="stagger-children grid gap-3.5 md:grid-cols-2 xl:grid-cols-3">
          {skills.map((s) => (
            <div
              key={s.name}
              className={`group relative flex flex-col overflow-hidden rounded-2xl border bg-zinc-900/40 p-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/25 ${
                s.enabled ? "border-zinc-800/70 hover:border-emerald-500/30" : "border-zinc-800/50 opacity-60"
              }`}
            >
              {s.enabled && (
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/25 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
              )}
              <div className="mb-2.5 flex items-start justify-between gap-2">
                <div>
                  <code className="text-[14px] font-bold text-emerald-300">/{s.name}</code>
                  <div className="mt-1.5 flex gap-1">
                    {s.auto && <Badge tone="violet">auto</Badge>}
                    {!s.enabled && <Badge>tắt</Badge>}
                  </div>
                </div>
                {isAdmin && (
                  <div className="flex items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                    <Toggle checked={s.enabled} onChange={(v) => save({ ...s, enabled: v })} />
                    <button onClick={() => setEdit({ skill: s, isNew: false })} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200">
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => del(s.name)} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-rose-950/40 hover:text-rose-300">
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>
              {s.description && <p className="mb-2.5 text-xs leading-relaxed text-zinc-400">{s.description}</p>}
              <p className="line-clamp-4 flex-1 whitespace-pre-wrap rounded-xl border border-zinc-800/50 bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-zinc-500">
                {s.prompt}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <Empty icon={Puzzle}>Chưa có skill nào</Empty>
      )}

      {isAdmin && (
        <Panel title="Mẫu có sẵn" icon={Sparkles}>
          <div className="flex flex-wrap gap-2">
            {TEMPLATES.filter((t) => !skills.some((s) => s.name === t.name)).map((t) => (
              <button
                key={t.name}
                onClick={() => setEdit({ skill: t, isNew: true })}
                className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-left transition hover:border-emerald-500/40 hover:bg-emerald-500/5"
              >
                <code className="text-xs text-emerald-300">/{t.name}</code>
                <div className="text-[10px] text-zinc-500">{t.description}</div>
              </button>
            ))}
          </div>
        </Panel>
      )}

      {edit && <SkillEditor initial={edit.skill} isNew={edit.isNew} onSave={save} onClose={() => setEdit(null)} />}
    </div>
  );
}

function SkillEditor({ initial, isNew, onSave, onClose }: { initial: Skill; isNew: boolean; onSave: (s: Skill) => void; onClose: () => void }) {
  const [s, setS] = useState(initial);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="animate-fade-in w-full max-w-xl space-y-4 rounded-2xl border border-zinc-800/70 bg-zinc-900/80 p-6 shadow-2xl shadow-black/60 backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800/60 pb-3.5">
          <h3 className="text-sm font-semibold tracking-tight text-zinc-100">{isNew ? "Tạo skill" : `Sửa /${s.name}`}</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200">
            <X size={16} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tên (trigger)" hint="a-z, 0-9, - _">
            <input value={s.name} disabled={!isNew} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder="review" className={inputCls} />
          </Field>
          <Field label="Mô tả">
            <input value={s.description} onChange={(e) => setS({ ...s, description: e.target.value })} className={inputCls} />
          </Field>
        </div>
        <Field label="System prompt">
          <textarea rows={8} value={s.prompt} onChange={(e) => setS({ ...s, prompt: e.target.value })} className={`${inputCls} font-mono text-[11px]`} />
        </Field>
        <div className="flex items-center justify-between rounded-xl border border-zinc-800/70 bg-zinc-900/30 p-3.5">
          <div>
            <div className="text-xs font-semibold text-zinc-200">Auto inject</div>
            <div className="text-[11px] text-zinc-500">Chèn vào mọi request, không cần gõ /{s.name || "tên"}</div>
          </div>
          <Toggle checked={s.auto} onChange={(v) => setS({ ...s, auto: v })} />
        </div>
        <Btn variant="primary" size="lg" className="w-full" disabled={!s.name.trim() || !s.prompt.trim()} onClick={() => onSave(s)}>
          <Save size={14} /> Lưu skill
        </Btn>
      </div>
    </div>
  );
}
