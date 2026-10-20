"use client";

import { Plug } from "lucide-react";
import { PageHeader, Panel } from "@/components/ui";

export default function McpPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={Plug}
        title="MCP — Model Context Protocol"
        desc="llm-router là OpenAI-compatible server, nên mọi MCP client (Claude Code, Cursor, Cline…) đều dùng được qua config openai-compatible / custom provider."
      />

      <Panel>
        <pre className="overflow-x-auto rounded-xl border border-zinc-800/70 bg-black/50 p-4 font-mono text-xs leading-relaxed text-emerald-200/90">
{`{
  "mcpServers": {
    "llm-router": {
      "type": "openai-compatible",
      "baseURL": "http://localhost:8080/v1",
      "apiKey": "sk-vk-ten-key-cua-ban"
    }
  }
}`}
        </pre>
        <p className="mt-3.5 text-xs leading-relaxed text-zinc-500">
          API key dùng ở đây là virtual key của llm-router (tạo ở tab API Keys) — nhận
          quyền model/provider glob, RPM và budget tương ứng.
        </p>
      </Panel>

      <Panel title="Roadmap MCP server mode">
        <ul className="list-inside list-disc space-y-1.5 text-xs leading-relaxed text-zinc-500">
          <li>Bước hiện tại: consumed AS OpenAI provider bởi MCP clients (trên).</li>
          <li>Tiếp theo: llm-router chạy MCP server riêng (stdio/SSE) expose tools dùng Kubernetes-style route config.</li>
          <li>MCP prompts/resources registry cho các tool embeddings + cache.</li>
        </ul>
      </Panel>
    </div>
  );
}