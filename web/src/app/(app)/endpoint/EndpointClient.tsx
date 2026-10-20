"use client";

import { useMemo, useState } from "react";
import { Boxes, Check, Globe, KeyRound, Pencil, Plus, RefreshCw, Search, Trash2, Wand2, X } from "lucide-react";
import { Badge, Btn, Code, CopyBtn, Empty, Field, PageHeader, Panel, api, inputCls, useFlash, useJson } from "@/components/ui";
import { useConnections, type ConnSummary } from "../providers/ProviderCatalog";

interface KeyRow {
  key: string;
  key_plain: string;
  owner: string;
  team?: string | null;
  allowed_models: string[] | null;
  allowed_providers: string[] | null;
  rpm: number | null;
  monthly_budget_usd: number | null;
}

function randomKey() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return "sk-vk-" + Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Toggleable chip used by both provider & model pickers. */
function Chip({
  on,
  onClick,
  children,
  tone = "emerald",
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
  tone?: "emerald" | "cyan";
}) {
  const active =
    tone === "cyan"
      ? "border-cyan-500/45 bg-cyan-500/12 text-cyan-200 shadow-[0_0_10px_rgba(6,182,212,0.10)]"
      : "border-emerald-500/45 bg-emerald-500/12 text-emerald-200 shadow-[0_0_10px_rgba(16,185,129,0.10)]";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left font-mono text-[11px] leading-tight transition-all duration-200 active:scale-[0.97] ${
        on
          ? active
          : "border-zinc-800 bg-zinc-950/60 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
      }`}
    >
      {on && <Check size={11} className="shrink-0" />}
      <span className="truncate">{children}</span>
    </button>
  );
}

const formInit = {
  key: "",
  owner: "",
  team: "",
  rpm: "",
  budget: "",
  models: ["*"] as string[],
  providers: [] as string[],
};

export default function EndpointClient({
  role,
  baseUrl,
  team,
  username,
}: {
  role: "admin" | "team_lead" | "user";
  baseUrl: string;
  /** Team id of the logged-in user (null for admins). */
  team?: string | null;
  username?: string;
}) {
  const { flash, node } = useFlash();
  const isAdmin = role === "admin";
  /** Team leads define the model/provider allow-lists; members can't. */
  const canConfigure = role !== "user";
  const keys = useJson<{ keys: KeyRow[] }>("/admin/keys");
  const models = useJson<{ data: { id: string }[] }>("/v1/models");
  const { conns, loaded: connsLoaded } = useConnections();
  const [q, setQ] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [form, setForm] = useState(formInit);
  const [editing, setEditing] = useState<KeyRow | null>(null);
  const [glob, setGlob] = useState("");

  const v1 = `${baseUrl}/v1`;

  /** Model ids visible to this role (admin: all; team lead: own team). */
  const teamModelIds = useMemo(() => {
    const out = new Set<string>();
    for (const c of conns) {
      const scope = c.prefix || c.name;
      for (const m of c.models ?? []) {
        out.add(m);
        if (scope !== c.name) out.add(`${scope}/${m}`);
      }
    }
    return Array.from(out);
  }, [conns]);

  const ids = useMemo(() => {
    const fromApi = (models.data?.data ?? []).map((m) => m.id);
    if (role === "admin") return fromApi;
    // A team lead may not have a key yet (so /v1/models is empty); fall back
    // to the models of their team's connections.
    return connsLoaded && teamModelIds.length ? teamModelIds : fromApi;
  }, [models.data, role, connsLoaded, teamModelIds]);
  const filtered = ids.filter((id) => id.toLowerCase().includes(q.toLowerCase()));
  const sample = ids.find((i) => i.includes("/")) ?? ids[0] ?? "gpt-4o-mini";

  /** Models narrowed to the selected providers (empty selection = all). */
  const providerIds = useMemo(() => new Set(form.providers), [form.providers]);
  const visibleModels = providerIds.size ? filtered.filter((m) => providerIds.has(m.split("/")[0])) : filtered;
  const selectedOutside = form.models.filter(
    (m) => !m.includes("*") && !visibleModels.includes(m) && (form.providers.length === 0 || providerIds.has(m.split("/")[0]) === false)
  );

  function toggleModel(id: string) {
    setForm((f) => ({
      ...f,
      models: f.models.includes(id) ? f.models.filter((m) => m !== id) : [...f.models.filter((m) => m !== "*"), id],
    }));
  }
  function toggleProvider(name: string) {
    setForm((f) => {
      const providers = f.providers.includes(name) ? f.providers.filter((p) => p !== name) : [...f.providers, name];
      // Keep selections valid: models of deselected providers stay as chips
      // (shown in "ngoài bộ lọc") but are still saved — removal is explicit.
      return { ...f, providers };
    });
  }
  function addGlob() {
    const g = glob.trim();
    if (!g) return;
    setForm((f) => (f.models.includes(g) ? f : { ...f, models: [...f.models.filter((m) => m !== "*"), g] }));
    setGlob("");
  }
  function resetForm(row?: KeyRow) {
    setGlob("");
    if (row) {
      setForm({
        key: row.key_plain ?? "",
        owner: row.owner ?? "",
        team: row.team ?? "",
        rpm: row.rpm != null ? String(row.rpm) : "",
        budget: row.monthly_budget_usd != null ? String(row.monthly_budget_usd) : "",
        models: row.allowed_models?.length ? [...row.allowed_models] : ["*"],
        providers: row.allowed_providers?.length ? [...row.allowed_providers] : [],
      });
    } else {
      setForm({ ...formInit, key: randomKey(), owner: role === "user" ? username || "" : "", team: team || "" });
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const key = (form.key ?? "").trim() || randomKey();
    // Owner: the user themself for member keys; free-text for leads/admins.
    const owner = role === "user" ? username || "user" : (form.owner ?? "").trim() || username || "default";
    try {
      await api("/admin/keys", {
        body: {
          key,
          owner,
          ...(isAdmin && form.team.trim() ? { team: form.team.trim() } : {}),
          // Member keys always get the whole team model surface; the BFF
          // enforces this server-side, so the picker is lead/admin-only.
          allowed_models: canConfigure && form.models?.length ? form.models : ["*"],
          allowed_providers: canConfigure && form.providers?.length ? form.providers : undefined,
          rpm: form.rpm ? Number(form.rpm) : undefined,
          monthly_budget_usd: form.budget ? Number(form.budget) : undefined,
        },
      });
      if (!editing) setCreated(key);
      setEditing(null);
      setForm({ ...formInit });
      flash(editing ? "✓ Đã cập nhật key" : "✓ Đã lưu key");
      keys.reload();
    } catch (err) {
      flash(`✗ ${(err as Error).message}`);
    }
  }

  async function del(key: string) {
    if (!confirm(`Xoá key ${key}?`)) return;
    try {
      await api("/admin/keys/delete", { body: { key } });
      keys.reload();
      flash("✓ Đã xoá key");
    } catch (err) {
      flash(`✗ ${(err as Error).message}`);
    }
  }

  const formPanel = (title: string, icon: typeof Plus) => (
    <Panel title={title} icon={icon}>
      <form onSubmit={save} className="space-y-3.5">
        {canConfigure ? (
          <>
            <Field label="Key" hint="Để trống để tự sinh ngẫu nhiên.">
              <div className="flex gap-1.5">
                <input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="sk-vk-…" className={`${inputCls} font-mono`} />
                <Btn type="button" onClick={() => setForm({ ...form, key: randomKey() })} title="Sinh key">
                  <Wand2 size={13} />
                </Btn>
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-2.5">
              <Field label="Owner">
                <input value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} placeholder="tên user" className={inputCls} />
              </Field>
              {isAdmin ? (
                <Field label="Team" hint="Bỏ trống = key toàn cục (admin).">
                  <input value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })} placeholder="team-a" className={inputCls} />
                </Field>
              ) : (
                <Field label="Team">
                  <input value={team || "—"} readOnly className={`${inputCls} opacity-70`} />
                </Field>
              )}
            </div>
          </>
        ) : (
          <Field label="Key" hint="Sinh tự động khi tạo — bạn chỉ cần đặt giới hạn dưới.">
            <input value="sk-vk-•••• (tự sinh)" readOnly className={`${inputCls} font-mono opacity-70`} />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="RPM">
            <input type="number" value={form.rpm} onChange={(e) => setForm({ ...form, rpm: e.target.value })} placeholder="∞" className={inputCls} />
          </Field>
          <Field label="Budget $/tháng">
            <input type="number" step="0.01" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} placeholder="∞" className={inputCls} />
          </Field>
        </div>
        {!canConfigure && (
          <p className="rounded-xl border border-zinc-800/70 bg-zinc-950/50 px-3 py-2 text-[11px] leading-relaxed text-zinc-500">
            Key của bạn sẽ dùng <span className="text-zinc-300">toàn bộ provider &amp; model của team</span>.
            Team lead sẽ giới hạn model (nếu cần) sau khi bạn tạo key.
          </p>
        )}

        {canConfigure && (
          <>
        {/* ---- Providers ---- */}
        <Field label="Providers cho phép" hint="Bấm để chọn. Chưa chọn = tất cả các provider.">
          <div className="rounded-xl border border-zinc-800/70 bg-zinc-950/50 p-2.5">
            {!connsLoaded && <p className="px-1 py-1 text-[11px] text-zinc-600">Đang tải danh sách provider…</p>}
            {connsLoaded && !conns.length && <p className="px-1 py-1 text-[11px] text-zinc-600">Chưa có provider nào được kết nối.</p>}
            {!!conns.length && (
              <div className="flex flex-wrap gap-1.5">
                {conns.map((c: ConnSummary) => (
                  <Chip key={c.name} on={form.providers.includes(c.name)} onClick={() => toggleProvider(c.name)}>
                    {c.display_name || c.name}
                    <span className="text-zinc-600">· {c.models.length}</span>
                  </Chip>
                ))}
              </div>
            )}
            <p className="mt-2 border-t border-zinc-800/60 pt-2 text-[10.5px] text-zinc-600">
              {form.providers.length ? `Đang giới hạn ${form.providers.length} provider` : "Không chọn = mọi provider"}
            </p>
          </div>
        </Field>

        {/* ---- Models ---- */}
        <Field label="Models cho phép" hint="Chọn provider trước để lọc model tương ứng. Glob tuỳ chỉnh: gpt-*, gh/*, coding…">
          <div className="rounded-xl border border-zinc-800/70 bg-zinc-950/50 p-2.5">
            <div className="relative mb-2">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Lọc model…" className={`${inputCls} py-1.5 pl-8 text-[11px]`} />
            </div>

            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Chip on={form.models.includes("*")} onClick={() => setForm({ ...form, models: form.models.includes("*") ? [] : ["*"] })}>
                * (mọi model)
              </Chip>
              <span className="text-zinc-700">|</span>
              <button
                type="button"
                onClick={() => setForm({ ...form, models: [...new Set([...form.models, ...visibleModels.filter((m) => !form.models.includes(m))])] })}
                className="rounded-lg px-1.5 py-1 text-[10.5px] text-zinc-500 transition hover:text-emerald-300"
              >
                Chọn {visibleModels.length} model hiển thị
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...form, models: ["*"] })}
                className="rounded-lg px-1.5 py-1 text-[10.5px] text-zinc-500 transition hover:text-rose-300"
              >
                Bỏ hết
              </button>
            </div>

            <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
              <div className="flex flex-wrap gap-1.5">
                {visibleModels.map((id) => (
                  <Chip key={id} tone="cyan" on={form.models.includes(id)} onClick={() => toggleModel(id)}>
                    {id}
                  </Chip>
                ))}
                {!visibleModels.length && <p className="px-1 py-2 text-[11px] text-zinc-600">Không có model khớp bộ lọc.</p>}
              </div>
            </div>

            {/* Selected (incl. globs) */}
            <div className="mt-2.5 border-t border-zinc-800/60 pt-2.5">
              <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-zinc-500">
                Đã chọn · {form.models.includes("*") ? "mọi model" : form.models.length}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {form.models.filter((m) => m !== "*").map((m) => (
                  <span
                    key={m}
                    className="inline-flex max-w-full items-center gap-1 rounded-lg border border-emerald-500/35 bg-emerald-500/10 py-1 pl-2 pr-1 font-mono text-[11px] text-emerald-200"
                  >
                    <span className="truncate">{m}</span>
                    <button type="button" onClick={() => toggleModel(m)} className="rounded p-0.5 text-emerald-400/70 transition hover:bg-emerald-500/20 hover:text-emerald-100">
                      <X size={11} />
                    </button>
                  </span>
                ))}
                {form.models.includes("*") && (
                  <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-2 py-1 font-mono text-[11px] text-emerald-200">
                    *
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, models: [] })}
                      className="rounded p-0.5 text-emerald-400/70 transition hover:bg-emerald-500/20 hover:text-emerald-100"
                    >
                      <X size={11} />
                    </button>
                  </span>
                )}
                {!form.models.length && <span className="text-[10.5px] text-zinc-600">Chưa chọn model nào</span>}
              </div>
              {!!selectedOutside.length && (
                <p className="mt-1.5 text-[10.5px] text-zinc-600">+ {selectedOutside.length} glob/model ngoài bộ lọc hiện tại (vẫn được lưu)</p>
              )}
            </div>

            <div className="mt-2.5 flex gap-1.5 border-t border-zinc-800/60 pt-2.5">
              <input
                value={glob}
                onChange={(e) => setGlob(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addGlob();
                  }
                }}
                placeholder="thêm glob: gpt-*, gh/*…"
                className={`${inputCls} py-1.5 font-mono text-[11px]`}
              />
              <Btn type="button" onClick={addGlob} disabled={!glob.trim()}>
                <Plus size={13} /> Thêm
              </Btn>
            </div>
          </div>
        </Field>
          </>
        )}

        <Btn variant="primary" size="lg" type="submit" className="w-full">
          {editing ? <><Check size={14} /> Cập nhật key</> : <><Plus size={14} /> Tạo key</>}
        </Btn>
        {editing && (
          <Btn
            type="button"
            className="w-full"
            onClick={() => {
              setEditing(null);
              setForm({ ...formInit });
            }}
          >
            <X size={13} /> Huỷ sửa
          </Btn>
        )}
      </form>
    </Panel>
  );

  return (
    <div className="space-y-6">
      {node}
      <PageHeader
        icon={KeyRound}
        title="Endpoint & Key"
        desc="Endpoint tương thích OpenAI. Mọi client hỗ trợ base URL tuỳ chỉnh (Claude Code, Cursor, Cline, Codex, OpenWebUI…) đều trỏ về đây được, dùng virtual key bên dưới."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Endpoint" icon={Globe} className="lg:col-span-2">
          <div className="space-y-3">
            {[
              ["Base URL (OpenAI)", v1],
              ["Chat completions", `${v1}/chat/completions`],
              ["Embeddings", `${v1}/embeddings`],
              ["Models", `${v1}/models`],
            ].map(([label, url]) => (
              <div
                key={label}
                className="group flex items-center gap-3 rounded-xl border border-zinc-800/70 bg-black/40 px-3.5 py-2.5 transition-all hover:border-zinc-700/80"
              >
                <span className="w-36 shrink-0 text-[11px] font-medium text-zinc-500">{label}</span>
                <code className="flex-1 truncate font-mono text-xs text-emerald-300">{url}</code>
                <span className="opacity-0 transition-opacity group-hover:opacity-100">
                  <CopyBtn text={url} />
                </span>
              </div>
            ))}
            <Code>{`curl ${v1}/chat/completions \\
  -H "Authorization: Bearer sk-vk-..." \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${sample}","messages":[{"role":"user","content":"Xin chào"}]}'`}</Code>
          </div>
        </Panel>

        <Panel
          title={<>Models <Badge>{ids.length}</Badge></>}
          icon={Boxes}
          actions={
            <button onClick={models.reload} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200">
              <RefreshCw size={14} />
            </button>
          }
        >
          <div className="relative mb-2.5">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Lọc model…" className={`${inputCls} pl-9`} />
          </div>
          <ul className="max-h-72 space-y-1 overflow-y-auto pr-1">
            {filtered.map((id) => (
              <li
                key={id}
                className="group flex items-center justify-between rounded-lg px-2.5 py-1.5 transition-colors hover:bg-zinc-800/50"
              >
                <code className="truncate font-mono text-[11px] text-zinc-300">{id}</code>
                <span className="opacity-0 transition-opacity group-hover:opacity-100">
                  <CopyBtn text={id} label="copy" />
                </span>
              </li>
            ))}
            {!filtered.length && <li className="px-2 py-4 text-center text-[11px] text-zinc-600">Không có model</li>}
          </ul>
        </Panel>
      </div>

      {(
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel
            title={
              <>
                {role === "user" ? "API keys của tôi" : "Virtual keys"}{" "}
                <Badge>{keys.data?.keys.length ?? 0}</Badge>
              </>
            }
            icon={KeyRound}
            className="lg:col-span-2"
            actions={
              <Btn size="sm" onClick={() => { setCreated(null); setEditing(null); resetForm(); }}>
                <Plus size={13} /> {role === "user" ? "Tạo key" : "Sinh key mới"}
              </Btn>
            }
          >
            {created && (
              <div className="animate-fade-in mb-4 rounded-xl border border-emerald-500/25 bg-emerald-950/20 p-3.5">
                <p className="mb-1.5 text-[11px] font-medium text-emerald-300">Key mới, hãy copy ngay vì sau này chỉ còn hiển thị dạng che:</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate font-mono text-xs text-zinc-100">{created}</code>
                  <CopyBtn text={created} />
                  <button onClick={() => setCreated(null)} className="text-[11px] text-zinc-500 transition-colors hover:text-zinc-200">ẩn</button>
                </div>
              </div>
            )}
            {keys.data?.keys.length ? (
              <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-zinc-900/90 text-[10px] uppercase tracking-wider text-zinc-500 backdrop-blur">
                    <tr className="border-b border-zinc-800">
                      <th className="px-3 py-2.5 font-medium">Key</th>
                      {role !== "user" && <th className="px-3 py-2.5 font-medium">Owner</th>}
                      {role === "admin" && <th className="px-3 py-2.5 font-medium">Team</th>}
                      <th className="px-3 py-2.5 font-medium">Models</th>
                      {role !== "user" && <th className="px-3 py-2.5 font-medium">Providers</th>}
                      <th className="px-3 py-2.5 font-medium">RPM</th>
                      <th className="px-3 py-2.5 font-medium">Budget/th</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {keys.data.keys.map((k) => (
                      <tr key={k.key_plain} className="border-b border-zinc-800/40 transition-colors last:border-0 hover:bg-zinc-800/20">
                        <td className="px-3 py-2.5 font-mono text-emerald-300">{k.key}</td>
                        {role !== "user" && <td className="px-3 py-2.5 font-medium text-zinc-300">{k.owner}</td>}
                        {role === "admin" && (
                          <td className="px-3 py-2.5 text-zinc-400">{k.team || "—"}</td>
                        )}
                        <td className="px-3 py-2.5 text-zinc-500">
                          <span className="line-clamp-2">{k.allowed_models?.join(", ") || "*"}</span>
                        </td>
                        {role !== "user" && (
                          <td className="px-3 py-2.5 text-zinc-500">{k.allowed_providers?.join(", ") || "*"}</td>
                        )}
                        <td className="px-3 py-2.5 tabular-nums text-zinc-400">{k.rpm ?? "—"}</td>
                        <td className="px-3 py-2.5 tabular-nums text-zinc-400">{k.monthly_budget_usd != null ? `$${k.monthly_budget_usd}` : "—"}</td>
                        <td className="px-3 py-2.5 text-right">
                          <span className="flex justify-end gap-0.5 opacity-60 transition-opacity hover:opacity-100">
                            {canConfigure && (
                              <button
                                onClick={() => { setCreated(null); setEditing(k); resetForm(k); }}
                                title="Sửa key"
                                className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100"
                              >
                                <Pencil size={13} />
                              </button>
                            )}
                            <button
                              onClick={() => del(k.key_plain)}
                              title="Xoá key"
                              className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-rose-950/40 hover:text-rose-300"
                            >
                              <Trash2 size={13} />
                            </button>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : role === "user" ? (
              <Empty icon={KeyRound}>Bạn chưa có key nào — bấm “Tạo key” để dùng dịch vụ (team sẽ được tự gán).</Empty>
            ) : (
              <Empty icon={KeyRound}>Chưa có key nào, router đang mở cho mọi request (anonymous). Thêm key để bật xác thực.</Empty>
            )}
          </Panel>

          {editing ? (
            <div className="animate-fade-in">{formPanel(`Sửa key ${editing.key}`, Pencil)}</div>
          ) : (
            formPanel(role === "user" ? "Tạo key của tôi" : "Tạo key", Plus)
          )}
        </div>
      )}
    </div>
  );
}
