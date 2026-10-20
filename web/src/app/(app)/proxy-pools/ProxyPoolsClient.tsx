"use client";

import { useState } from "react";
import { ArrowRight, Globe, Network, Plus, Radar, Server, Trash2 } from "lucide-react";
import { Badge, Btn, Empty, Field, PageHeader, Panel, Select, Toggle, api, inputCls, useFlash, useJson } from "@/components/ui";

interface Proxy {
  name: string;
  url: string;
  enabled: boolean;
  used_by: string[];
}
interface Data {
  proxies: Proxy[];
  assignments: Record<string, string>;
  providers: string[];
}

export default function ProxyPoolsClient({ isAdmin }: { isAdmin: boolean }) {
  const { flash, node } = useFlash();
  const { data, reload } = useJson<Data>("/admin/proxies");
  const [form, setForm] = useState({ name: "", url: "" });
  const [tests, setTests] = useState<Record<string, string>>({});

  async function run(fn: () => Promise<unknown>, ok?: string) {
    try {
      await fn();
      if (ok) flash(ok);
      reload();
    } catch (e) {
      flash(`✗ ${(e as Error).message}`);
    }
  }

  async function test(name: string, url?: string) {
    setTests((t) => ({ ...t, [name]: "…" }));
    try {
      const r = await api<{ ok: boolean; ip?: string; latency_ms?: number; error?: string }>("/admin/proxies/test", { body: { name, url } });
      setTests((t) => ({ ...t, [name]: r.ok ? `✓ IP ${r.ip} · ${r.latency_ms}ms` : `✗ ${r.error}` }));
    } catch (e) {
      setTests((t) => ({ ...t, [name]: `✗ ${(e as Error).message}` }));
    }
  }

  const proxies = data?.proxies ?? [];

  return (
    <div className="space-y-6">
      {node}
      <PageHeader
        icon={Network}
        title="Proxy Pools"
        desc="Định tuyến request ra upstream qua HTTP, HTTPS hoặc SOCKS5 proxy riêng cho từng provider, ví dụ để vượt chặn theo vùng hoặc tách IP giữa các tài khoản. Provider không được gán proxy sẽ kết nối trực tiếp."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title={<>Proxies <Badge>{proxies.length}</Badge></>} icon={Globe} className="lg:col-span-2">
          {proxies.length ? (
            <div className="space-y-2.5">
              {proxies.map((p) => (
                <div
                  key={p.name}
                  className={`rounded-2xl border p-3.5 transition-all duration-300 ${
                    p.enabled ? "border-zinc-800/70 bg-zinc-900/40 hover:border-zinc-700/80" : "border-zinc-800/50 bg-zinc-900/20 opacity-70"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <div
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        p.enabled ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" : "bg-zinc-600"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-zinc-100">{p.name}</div>
                      <code className="block truncate font-mono text-[11px] text-zinc-500">{p.url}</code>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {p.used_by.map((u) => (
                        <Badge key={u} tone="cyan">{u}</Badge>
                      ))}
                    </div>
                    <Btn size="sm" onClick={() => test(p.name)}>
                      <Radar size={13} /> Test
                    </Btn>
                    {isAdmin && (
                      <>
                        <Toggle checked={p.enabled} onChange={(v) => run(() => api("/admin/proxies", { body: { name: p.name, enabled: v } }))} />
                        <button
                          onClick={() => confirm(`Xoá proxy ${p.name}?`) && run(() => api(`/admin/proxies/${encodeURIComponent(p.name)}`, { method: "DELETE" }), "✓ Đã xoá")}
                          className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-rose-950/40 hover:text-rose-300"
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                  {tests[p.name] && (
                    <p
                      className={`mt-2.5 rounded-lg border px-3 py-1.5 font-mono text-[11px] animate-fade-in ${
                        tests[p.name].startsWith("✓")
                          ? "border-emerald-500/25 bg-emerald-950/20 text-emerald-300"
                          : tests[p.name] === "…"
                            ? "border-zinc-800 text-zinc-500"
                            : "border-rose-500/25 bg-rose-950/20 text-rose-300"
                      }`}
                    >
                      {tests[p.name]}
                    </p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <Empty icon={Globe}>Chưa có proxy nào</Empty>
          )}
        </Panel>

        {isAdmin && (
          <Panel title="Thêm proxy" icon={Plus}>
            <div className="space-y-3">
              <Field label="Tên">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="us-residential" className={inputCls} />
              </Field>
              <Field label="URL" hint="http://host:port · socks5://user:pass@host:port (mật khẩu được che khi hiển thị)">
                <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="socks5://127.0.0.1:1080" className={inputCls} />
              </Field>
              <div className="flex gap-2">
                <Btn onClick={() => form.url && test(form.name || "_new", form.url)} disabled={!form.url}>
                  <Radar size={13} /> Test
                </Btn>
                <Btn
                  variant="primary"
                  className="flex-1"
                  disabled={!form.name || !form.url}
                  onClick={() =>
                    run(async () => {
                      await api("/admin/proxies", { body: { ...form, enabled: true } });
                      setForm({ name: "", url: "" });
                    }, "✓ Đã thêm proxy")
                  }
                >
                  <Plus size={13} /> Thêm
                </Btn>
              </div>
              {tests[form.name || "_new"] && <p className="text-[11px] text-zinc-400">{tests[form.name || "_new"]}</p>}
            </div>
          </Panel>
        )}
      </div>

      <Panel title="Gán proxy cho provider" icon={Server}>
        {data?.providers.length ? (
          <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
            {data.providers.map((prov) => (
              <div key={prov} className="flex items-center gap-2.5 rounded-xl border border-zinc-800/70 bg-zinc-900/40 px-3.5 py-2.5 transition-colors hover:border-zinc-700/80">
                <span className="flex-1 truncate font-mono text-xs text-zinc-200">{prov}</span>
                <ArrowRight size={12} className="text-zinc-600" />
                <Select
                  value={data.assignments[prov] ?? ""}
                  disabled={!isAdmin}
                  onChange={(e) => run(() => api("/admin/proxies/assign", { body: { provider: prov, proxy: e.target.value || null } }), "✓ Đã gán")}
                >
                  <option value="">Trực tiếp</option>
                  {proxies.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                      {!p.enabled ? " (tắt)" : ""}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
        ) : (
          <Empty icon={Server}>Chưa có provider</Empty>
        )}
      </Panel>
    </div>
  );
}
