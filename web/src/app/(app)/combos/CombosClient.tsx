"use client";

import { useEffect, useState } from "react";
import { Eye, GripVertical, Layers, Pencil, Plus, Save, Trash2, TriangleAlert, X } from "lucide-react";
import { Badge, Btn, CopyBtn, Empty, Field, PageHeader, Panel, Stat, Toggle, api, inputCls, useFlash, useJson } from "@/components/ui";

interface Combo {
  name: string;
  models: string[];
  description?: string;
}
interface Vision {
  enabled: boolean;
  vision_model: string;
  native_models: string[];
  prompt: string;
}

export default function CombosClient({ isAdmin }: { isAdmin: boolean }) {
  const { flash, node } = useFlash();
  const combos = useJson<{ combos: Combo[] }>("/admin/combos");
  const modelsRes = useJson<{ data: { id: string }[] }>("/v1/models");
  const vision = useJson<{ settings: Vision; counters: { vision_runs: number } }>("/admin/vision");
  const [edit, setEdit] = useState<Combo | null>(null);

  const all = (modelsRes.data?.data ?? []).map((m) => m.id);
  const models = all.filter((id) => id.includes("/"));
  const list = combos.data?.combos ?? [];

  async function save(c: Combo) {
    try {
      await api("/admin/combos", { body: c });
      flash(`✓ Đã lưu combo ${c.name}`);
      setEdit(null);
      combos.reload();
    } catch (e) {
      flash(`✗ ${(e as Error).message}`);
    }
  }

  async function remove(name: string) {
    if (!confirm(`Xoá combo ${name}?`)) return;
    try {
      await api(`/admin/combos/${encodeURIComponent(name)}`, { method: "DELETE" });
      combos.reload();
    } catch (e) {
      flash(`✗ ${(e as Error).message}`);
    }
  }

  return (
    <div className="space-y-6">
      {node}
      <PageHeader
        icon={Layers}
        title="Combo & Vision Adapter"
        desc={
          <>
            Combo là một model ảo: gọi <code className="text-emerald-300">model: &quot;tên-combo&quot;</code>, router thử lần lượt từng model trong chuỗi. Model nào lỗi, bị 429 hoặc hết quota thì chuyển sang model kế tiếp. Vision Adapter giúp model chỉ đọc chữ vẫn xử lý được ảnh.
          </>
        }
        actions={
          isAdmin && (
            <Btn variant="primary" onClick={() => setEdit({ name: "", models: [] })}>
              <Plus size={13} /> Tạo combo
            </Btn>
          )
        }
      />

      <div className="stagger-children grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <Stat label="Combos" value={list.length} icon={Layers} />
        <Stat label="Models khả dụng" value={models.length} icon={Layers} tone="cyan" />
        <Stat label="Vision adapter" value={vision.data?.settings.enabled ? "Bật" : "Tắt"} icon={Eye} tone="violet" />
        <Stat label="Ảnh đã mô tả" value={vision.data?.counters.vision_runs ?? 0} icon={Eye} tone="amber" />
      </div>

      <Panel title="Combos" icon={Layers}>
        {list.length ? (
          <div className="grid gap-3.5 md:grid-cols-2 xl:grid-cols-3">
            {list.map((c) => (
              <div
                key={c.name}
                className="group relative overflow-hidden rounded-2xl border border-zinc-800/70 bg-zinc-900/40 p-4 transition-all duration-300 hover:-translate-y-0.5 hover:border-zinc-700/80 hover:shadow-lg hover:shadow-black/25"
              >
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/25 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                <div className="mb-2.5 flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <code className="truncate text-[13px] font-bold text-emerald-300">{c.name}</code>
                    <CopyBtn text={c.name} label="copy" />
                  </div>
                  {isAdmin && (
                    <span className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button onClick={() => setEdit(c)} className="rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => remove(c.name)} className="rounded-lg p-1.5 text-zinc-400 transition hover:bg-rose-950/40 hover:text-rose-300">
                        <Trash2 size={13} />
                      </button>
                    </span>
                  )}
                </div>
                {c.description && <p className="mb-2.5 text-[11px] leading-relaxed text-zinc-500">{c.description}</p>}
                <ol className="relative space-y-2 border-l border-zinc-800 pl-3.5">
                  {c.models.map((m, i) => (
                    <li key={i} className="relative flex items-center gap-2 font-mono text-[11px] text-zinc-300">
                      <span
                        className={`absolute -left-[19px] h-2 w-2 rounded-full ${
                          i === 0 ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" : "bg-zinc-600"
                        }`}
                      />
                      <span className="truncate">{m}</span>
                      {!models.includes(m) && (
                        <span className="text-amber-500" title="Model không khả dụng (provider chưa kết nối?)">
                          <TriangleAlert size={11} />
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        ) : (
          <Empty icon={Layers}>Chưa có combo nào. Tạo một combo, ví dụ coding → gh/gpt-4.1, or/deepseek…</Empty>
        )}
      </Panel>

      {vision.data && <VisionPanel key={JSON.stringify(vision.data.settings)} initial={vision.data.settings} models={all} isAdmin={isAdmin} onSaved={(m) => { flash(m); vision.reload(); }} />}

      {edit && <ComboEditor combo={edit} models={models} onSave={save} onClose={() => setEdit(null)} />}
    </div>
  );
}

function VisionPanel({ initial, models, isAdmin, onSaved }: { initial: Vision; models: string[]; isAdmin: boolean; onSaved: (m: string) => void }) {
  const [v, setV] = useState(initial);
  const [native, setNative] = useState(initial.native_models.join(", "));

  async function save(next: Vision) {
    try {
      await api("/admin/vision", { body: { ...next, native_models: native.split(",").map((s) => s.trim()).filter(Boolean) } });
      onSaved("✓ Đã lưu Vision Adapter");
    } catch (e) {
      onSaved(`✗ ${(e as Error).message}`);
    }
  }

  return (
    <Panel
      title="Vision Adapter"
      icon={Eye}
      actions={<Toggle checked={v.enabled} disabled={!isAdmin} onChange={(e) => setV({ ...v, enabled: e })} />}
    >
      <div className="mb-4 grid gap-3 rounded-2xl border border-zinc-800/70 bg-zinc-900/30 p-3.5 text-[11px] text-zinc-400 md:grid-cols-3">
        <div><span className="mr-1 font-bold text-emerald-300">1.</span>Request có ảnh gửi tới một model không hỗ trợ ảnh.</div>
        <div><span className="mr-1 font-bold text-emerald-300">2.</span>Router nhờ <b>vision model</b> mô tả ảnh thành văn bản.</div>
        <div><span className="mr-1 font-bold text-emerald-300">3.</span>Ảnh được thay bằng phần mô tả rồi chuyển tới model gốc.</div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Vision model" hint="provider/model, prefix/model hoặc tên combo; phải là model nhận được ảnh.">
          <input list="vision-models" value={v.vision_model} disabled={!isAdmin} onChange={(e) => setV({ ...v, vision_model: e.target.value })} placeholder="gh/gpt-4o" className={inputCls} />
          <datalist id="vision-models">
            {models.map((m) => <option key={m} value={m} />)}
          </datalist>
        </Field>
        <Field label="Model hỗ trợ ảnh sẵn (bỏ qua adapter)" hint="Glob, cách nhau bằng dấu phẩy">
          <input value={native} disabled={!isAdmin} onChange={(e) => setNative(e.target.value)} className={inputCls} />
        </Field>
        <div className="md:col-span-2">
          <Field label="Prompt mô tả ảnh">
            <textarea rows={2} value={v.prompt} disabled={!isAdmin} onChange={(e) => setV({ ...v, prompt: e.target.value })} className={inputCls} />
          </Field>
        </div>
      </div>
      {isAdmin && (
        <Btn variant="primary" className="mt-4" onClick={() => save(v)}>
          <Save size={13} /> Lưu Vision Adapter
        </Btn>
      )}
    </Panel>
  );
}

function ComboEditor({ combo, models, onSave, onClose }: { combo: Combo; models: string[]; onSave: (c: Combo) => void; onClose: () => void }) {
  const [name, setName] = useState(combo.name);
  const [desc, setDesc] = useState(combo.description ?? "");
  const [list, setList] = useState<string[]>(combo.models);
  const [pick, setPick] = useState("");
  const [drag, setDrag] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const add = () => {
    if (pick.trim() && !list.includes(pick.trim())) setList([...list, pick.trim()]);
    setPick("");
  };

  const dropOn = (i: number) => {
    if (drag === null || drag === i) return;
    const next = [...list];
    const [m] = next.splice(drag, 1);
    next.splice(i, 0, m);
    setList(next);
    setDrag(i);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="animate-fade-in w-full max-w-lg space-y-4 rounded-2xl border border-zinc-800/70 bg-zinc-900/80 p-6 shadow-2xl shadow-black/60 backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800/60 pb-3.5">
          <h3 className="text-sm font-semibold tracking-tight text-zinc-100">{combo.name ? `Sửa combo ${combo.name}` : "Tạo combo"}</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200">
            <X size={16} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tên">
            <input placeholder="coding" value={name} disabled={!!combo.name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Mô tả">
            <input placeholder="tuỳ chọn" value={desc} onChange={(e) => setDesc(e.target.value)} className={inputCls} />
          </Field>
        </div>
        <div className="flex gap-2">
          <input
            list="combo-models"
            placeholder="provider/model hoặc prefix/model"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            className={inputCls}
          />
          <datalist id="combo-models">
            {models.map((m) => <option key={m} value={m} />)}
          </datalist>
          <Btn onClick={add}>
            <Plus size={13} /> Thêm
          </Btn>
        </div>
        <ol className="max-h-72 space-y-1.5 overflow-y-auto">
          {list.map((m, i) => (
            <li
              key={m}
              draggable
              onDragStart={() => setDrag(i)}
              onDragOver={(e) => {
                e.preventDefault();
                dropOn(i);
              }}
              onDragEnd={() => setDrag(null)}
              className={`flex cursor-grab items-center gap-2 rounded-lg border px-2 py-1.5 font-mono text-[11px] transition active:cursor-grabbing ${
                drag === i ? "border-emerald-500/50 bg-emerald-500/10" : "border-zinc-800 bg-zinc-950/50"
              }`}
            >
              <GripVertical size={13} className="text-zinc-600" />
              <span className={`grid h-4 w-4 place-items-center rounded text-[9px] ${i === 0 ? "bg-emerald-500/20 text-emerald-300" : "bg-zinc-800 text-zinc-500"}`}>{i + 1}</span>
              <span className="flex-1 truncate text-zinc-200">{m}</span>
              {!models.includes(m) && <TriangleAlert size={11} className="text-amber-500" />}
              <button onClick={() => setList(list.filter((_, k) => k !== i))} className="text-zinc-600 hover:text-rose-300">
                <X size={13} />
              </button>
            </li>
          ))}
          {!list.length && <li className="py-4 text-center text-[11px] text-zinc-600">Thêm ít nhất 1 model. Kéo thả để đổi thứ tự ưu tiên.</li>}
        </ol>
        {list.length > 0 && (
          <p className="text-[10px] text-zinc-600">
            <Badge tone="emerald">1</Badge> được thử trước; kéo thả để đổi thứ tự.
          </p>
        )}
        <Btn
          variant="primary"
          size="lg"
          className="w-full"
          onClick={() => onSave({ name: name.trim(), models: list, description: desc.trim() || undefined })}
          disabled={!name.trim() || !list.length}
        >
          <Save size={14} /> Lưu combo
        </Btn>
      </div>
    </div>
  );
}
