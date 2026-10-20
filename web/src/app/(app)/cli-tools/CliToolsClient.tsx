"use client";

import { useMemo, useState } from "react";
import { SquareTerminal } from "lucide-react";
import { Badge, Code, Field, PageHeader, Panel, inputCls, useJson } from "@/components/ui";

type Tool = {
  id: string;
  name: string;
  kind: string;
  note?: string;
  steps: (v: { base: string; v1: string; key: string; model: string }) => { title: string; code: string }[];
};

const TOOLS: Tool[] = [
  {
    id: "opencode",
    name: "OpenCode",
    kind: "CLI",
    steps: ({ v1, key, model }) => [
      {
        title: "~/.config/opencode/opencode.json",
        code: JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            provider: {
              "llm-router": {
                npm: "@ai-sdk/openai-compatible",
                name: "LLM Router",
                options: { baseURL: v1, apiKey: key },
                models: { [model]: { name: model } },
              },
            },
            model: `llm-router/${model}`,
          },
          null,
          2,
        ),
      },
    ],
  },
  {
    id: "codex",
    name: "OpenAI Codex CLI",
    kind: "CLI",
    steps: ({ v1, key, model }) => [
      {
        title: "~/.codex/config.toml",
        code: `model = "${model}"
model_provider = "llmrouter"

[model_providers.llmrouter]
name = "LLM Router"
base_url = "${v1}"
env_key = "LLM_ROUTER_KEY"
wire_api = "chat"`,
      },
      { title: "Shell", code: `export LLM_ROUTER_KEY="${key}"\ncodex` },
    ],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    kind: "CLI",
    note: "Claude Code dùng Anthropic Messages API (/v1/messages). Router hiện chỉ expose API kiểu OpenAI, nên cần một lớp chuyển đổi như claude-code-router hoặc LiteLLM đứng giữa.",
    steps: ({ v1, key, model }) => [
      {
        title: "~/.claude-code-router/config.json (claude-code-router)",
        code: JSON.stringify(
          {
            Providers: [{ name: "llm-router", api_base_url: `${v1}/chat/completions`, api_key: key, models: [model] }],
            Router: { default: `llm-router,${model}` },
          },
          null,
          2,
        ),
      },
      { title: "Shell", code: "npm i -g @musistudio/claude-code-router\nccr code" },
    ],
  },
  {
    id: "aider",
    name: "Aider",
    kind: "CLI",
    steps: ({ v1, key, model }) => [
      { title: "Shell", code: `export OPENAI_API_BASE="${v1}"\nexport OPENAI_API_KEY="${key}"\naider --model openai/${model}` },
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    kind: "IDE",
    steps: ({ v1, key, model }) => [
      {
        title: "Settings → Models",
        code: `OpenAI API Key:      ${key}
Override Base URL:   ${v1}
Add model:           ${model}`,
      },
    ],
    note: "Cursor gọi API từ server của họ, nên base URL phải truy cập được từ internet (dùng tunnel như cloudflared hoặc ngrok).",
  },
  {
    id: "cline",
    name: "Cline / Roo Code",
    kind: "VS Code",
    steps: ({ v1, key, model }) => [
      {
        title: "Cline → API Provider: OpenAI Compatible",
        code: `Base URL:  ${v1}
API Key:   ${key}
Model ID:  ${model}`,
      },
    ],
  },
  {
    id: "continue",
    name: "Continue",
    kind: "VS Code / JetBrains",
    steps: ({ v1, key, model }) => [
      {
        title: "~/.continue/config.yaml",
        code: `models:
  - name: LLM Router
    provider: openai
    model: ${model}
    apiBase: ${v1}
    apiKey: ${key}
    roles: [chat, edit, apply]`,
      },
    ],
  },
  {
    id: "openwebui",
    name: "Open WebUI",
    kind: "Web",
    steps: ({ v1, key }) => [
      {
        title: "Admin → Settings → Connections → OpenAI API",
        code: `URL:  ${v1}
Key:  ${key}`,
      },
    ],
  },
  {
    id: "python",
    name: "Python (openai SDK)",
    kind: "SDK",
    steps: ({ v1, key, model }) => [
      {
        title: "main.py",
        code: `from openai import OpenAI

client = OpenAI(base_url="${v1}", api_key="${key}")
r = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Xin chào"}],
)
print(r.choices[0].message.content)`,
      },
    ],
  },
  {
    id: "node",
    name: "Node.js (openai SDK)",
    kind: "SDK",
    steps: ({ v1, key, model }) => [
      {
        title: "index.mjs",
        code: `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${v1}", apiKey: "${key}" });
const r = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "Xin chào" }],
});
console.log(r.choices[0].message.content);`,
      },
    ],
  },
];

export default function CliToolsClient({ baseUrl }: { baseUrl: string }) {
  const models = useJson<{ data: { id: string }[] }>("/v1/models");
  const ids = useMemo(() => (models.data?.data ?? []).map((m) => m.id), [models.data]);
  const [tool, setTool] = useState(TOOLS[0].id);
  const [key, setKey] = useState("sk-vk-your-key");
  const [model, setModel] = useState("");
  const m = model || ids.find((i) => i.includes("/")) || ids[0] || "gpt-4o-mini";
  const t = TOOLS.find((x) => x.id === tool)!;
  const v = { base: baseUrl, v1: `${baseUrl}/v1`, key, model: m };

  return (
    <div className="space-y-6">
      <PageHeader icon={SquareTerminal} title="CLI Tools" desc="Cấu hình mẫu để trỏ các công cụ AI coding về router. Chọn công cụ, key và model; cấu hình bên dưới tự cập nhật theo." />

      <Panel>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Base URL">
            <input value={v.v1} readOnly className={`${inputCls} text-zinc-400`} />
          </Field>
          <Field label="API key (virtual key)">
            <input value={key} onChange={(e) => setKey(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Model">
            <input list="cli-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder={m} className={inputCls} />
            <datalist id="cli-models">
              {ids.map((i) => <option key={i} value={i} />)}
            </datalist>
          </Field>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <div className="stagger-children space-y-1.5">
          {TOOLS.map((x) => (
            <button
              key={x.id}
              onClick={() => setTool(x.id)}
              className={`flex w-full items-center justify-between rounded-xl border px-3.5 py-2.5 text-left text-xs transition-all duration-200 ${
                tool === x.id
                  ? "border-emerald-500/40 bg-emerald-500/10 text-zinc-50 shadow-[0_0_12px_rgba(16,185,129,0.08)]"
                  : "border-zinc-800/70 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:bg-zinc-800/60 hover:text-zinc-200"
              }`}
            >
              <span className="font-medium">{x.name}</span>
              <Badge>{x.kind}</Badge>
            </button>
          ))}
        </div>
        <Panel title={t.name} icon={SquareTerminal}>
          {t.note && (
            <p className="mb-4 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3.5 text-[11px] leading-relaxed text-amber-200/80">{t.note}</p>
          )}
          <div className="space-y-4">
            {t.steps(v).map((s, i) => (
              <div key={i}>
                <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-zinc-400">
                  <span className="grid h-5 w-5 place-items-center rounded-lg bg-zinc-800/70 text-[10px] text-zinc-300">{i + 1}</span>
                  {s.title}
                </div>
                <Code>{s.code}</Code>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
