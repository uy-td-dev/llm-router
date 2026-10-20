/**
 * Provider catalog (9router-style). Client-safe: no secrets.
 *  - kind "oauth":   Connect button → login flow in the browser
 *  - kind "free":    free-tier providers
 *  - kind "apikey":  paste key → test → save
 *  - status "blocked": shown but not connectable (provider terms forbid
 *    third-party use of consumer subscriptions)
 */

export type Kind = "oauth" | "free" | "apikey";
export type Format = "openai" | "anthropic" | "google";

export interface CatalogEntry {
  id: string; // router provider name
  name: string;
  kind: Kind;
  format: Format;
  baseUrl: string;
  models: string[];
  keyUrl?: string;
  keyHint?: string;
  oauth?: "github-device" | "openrouter-pkce" | "claude-pkce";
  blocked?: string;
  /** Catalog ids offering the same models legitimately. */
  alternatives?: string[];
  soon?: string;
  color: string;
  /** Default short alias, used as `<prefix>/<model>`. */
  prefix?: string;
  custom?: boolean;
}

const PREFIX: Record<string, string> = {
  "github-copilot": "gh", openrouter: "or", gemini: "gm", "nvidia-nim": "nv", groq: "gq",
  cerebras: "cb", "ollama-cloud": "ol", mistral: "ms", openai: "oa", anthropic: "an",
  deepseek: "ds", xai: "xai", "zai-glm": "glm", kimi: "kimi", minimax: "mm", together: "tg",
  fireworks: "fw", chutes: "ch", featherless: "fl", perplexity: "pplx", siliconflow: "sf", cohere: "co",
};

/** Catalog entry for a saved connection (custom providers fall back to it). */
export function entryFor(id: string, conn?: { format: string; base_url: string; models: string[]; display_name?: string | null }): CatalogEntry | undefined {
  const base = findEntry(id);
  if (base) return { ...base, prefix: base.prefix ?? PREFIX[id] };
  if (!conn) return undefined;
  return {
    id, name: conn.display_name || id, kind: "apikey", format: conn.format as Format,
    baseUrl: conn.base_url, models: conn.models, color: "#52525b", custom: true,
  };
}

const BLOCKED_SUB =
  "Gói thuê bao của nhà cung cấp chỉ được dùng trong app chính chủ — kết nối từ router bên thứ ba vi phạm điều khoản và có thể bị khoá tài khoản.";

export const CATALOG: CatalogEntry[] = [
  // ---------------- OAuth ----------------
  {
    id: "github-copilot", name: "GitHub Copilot", kind: "oauth", format: "openai",
    baseUrl: "https://api.githubcopilot.com", models: [], oauth: "github-device", color: "#6e40c9",
  },
  {
    id: "openrouter", name: "OpenRouter", kind: "oauth", format: "openai",
    baseUrl: "https://openrouter.ai/api/v1", oauth: "openrouter-pkce", color: "#6467f2",
    models: [
      "deepseek/deepseek-chat-v3.1:free", "qwen/qwen3-coder:free", "z-ai/glm-4.5-air:free",
      "meta-llama/llama-3.3-70b-instruct:free", "openai/gpt-oss-120b:free",
      "anthropic/claude-sonnet-4.5", "openai/gpt-5", "google/gemini-2.5-pro",
    ],
  },
  {
    id: "claude-code", name: "Claude Code", kind: "oauth", format: "anthropic",
    baseUrl: "https://api.anthropic.com/v1", oauth: "claude-pkce", color: "#d97757", prefix: "cc",
    models: ["claude-opus-5-5", "claude-sonnet-4-5", "claude-haiku-4-5"],
  },
  { id: "antigravity", name: "Antigravity", kind: "oauth", format: "google", baseUrl: "", models: [], blocked: BLOCKED_SUB, alternatives: ["gemini", "github-copilot", "openrouter"], color: "#4285f4" },
  { id: "openai-codex", name: "OpenAI Codex", kind: "oauth", format: "openai", baseUrl: "", models: [], soon: "Cần wire format Responses API — sẽ bổ sung.", color: "#10a37f" },
  { id: "cursor", name: "Cursor IDE", kind: "oauth", format: "openai", baseUrl: "", models: [], blocked: BLOCKED_SUB, color: "#888" },

  // ---------------- Free tier ----------------
  {
    id: "gemini", name: "Gemini (AI Studio)", kind: "free", format: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta", color: "#4285f4",
    models: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"],
    keyUrl: "https://aistudio.google.com/app/apikey", keyHint: "AIza… — free tier có rate limit",
  },
  {
    id: "nvidia-nim", name: "NVIDIA NIM", kind: "free", format: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1", color: "#76b900",
    models: ["deepseek-ai/deepseek-v3.1", "qwen/qwen3-coder-480b-a35b-instruct", "moonshotai/kimi-k2-instruct", "meta/llama-3.3-70b-instruct"],
    keyUrl: "https://build.nvidia.com/settings/api-keys", keyHint: "nvapi-… (miễn phí, giới hạn RPM)",
  },
  {
    id: "groq", name: "Groq", kind: "free", format: "openai",
    baseUrl: "https://api.groq.com/openai/v1", color: "#f55036",
    models: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "moonshotai/kimi-k2-instruct", "qwen/qwen3-32b"],
    keyUrl: "https://console.groq.com/keys", keyHint: "gsk_… (free tier)",
  },
  {
    id: "cerebras", name: "Cerebras", kind: "free", format: "openai",
    baseUrl: "https://api.cerebras.ai/v1", color: "#f05a28",
    models: ["gpt-oss-120b", "qwen-3-coder-480b", "llama-3.3-70b"],
    keyUrl: "https://cloud.cerebras.ai/platform", keyHint: "csk-… (free tier)",
  },
  {
    id: "ollama-cloud", name: "Ollama Cloud", kind: "free", format: "openai",
    baseUrl: "https://ollama.com/v1", color: "#aaa",
    models: ["gpt-oss:120b", "deepseek-v3.1:671b", "qwen3-coder:480b", "kimi-k2:1t"],
    keyUrl: "https://ollama.com/settings/keys", keyHint: "Free tier theo giờ",
  },
  {
    id: "mistral", name: "Mistral", kind: "free", format: "openai",
    baseUrl: "https://api.mistral.ai/v1", color: "#fa520f",
    models: ["mistral-small-latest", "codestral-latest", "mistral-large-latest"],
    keyUrl: "https://console.mistral.ai/api-keys", keyHint: "Gói Experiment miễn phí",
  },
  { id: "opencode-free", name: "OpenCode Free", kind: "free", format: "openai", baseUrl: "", models: [], blocked: "OpenCode trả 403: free tier chỉ dùng được bên trong app OpenCode.", color: "#999" },
  { id: "gemini-cli", name: "Gemini CLI", kind: "free", format: "google", baseUrl: "", models: [], blocked: BLOCKED_SUB, alternatives: ["gemini", "github-copilot"], color: "#4285f4" },

  // ---------------- API key ----------------
  { id: "openai", name: "OpenAI", kind: "apikey", format: "openai", baseUrl: "https://api.openai.com/v1", color: "#10a37f",
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o-mini"], keyUrl: "https://platform.openai.com/api-keys", keyHint: "sk-…" },
  { id: "anthropic", name: "Anthropic", kind: "apikey", format: "anthropic", baseUrl: "https://api.anthropic.com/v1", color: "#d97757",
    models: ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-1"], keyUrl: "https://console.anthropic.com/settings/keys", keyHint: "sk-ant-api…" },
  { id: "deepseek", name: "DeepSeek", kind: "apikey", format: "openai", baseUrl: "https://api.deepseek.com/v1", color: "#4d6bfe",
    models: ["deepseek-chat", "deepseek-reasoner"], keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "xai", name: "xAI (Grok)", kind: "apikey", format: "openai", baseUrl: "https://api.x.ai/v1", color: "#ddd",
    models: ["grok-4", "grok-code-fast-1", "grok-3-mini"], keyUrl: "https://console.x.ai" },
  { id: "zai-glm", name: "Z.ai GLM Coding", kind: "apikey", format: "openai", baseUrl: "https://api.z.ai/api/coding/paas/v4", color: "#3b82f6",
    models: ["glm-4.6", "glm-4.5-air"], keyUrl: "https://z.ai/manage-apikey/apikey-list" },
  { id: "kimi", name: "Kimi (Moonshot)", kind: "apikey", format: "openai", baseUrl: "https://api.moonshot.ai/v1", color: "#111",
    models: ["kimi-k2-0905-preview", "kimi-k2-turbo-preview"], keyUrl: "https://platform.moonshot.ai/console/api-keys" },
  { id: "minimax", name: "MiniMax", kind: "apikey", format: "openai", baseUrl: "https://api.minimax.io/v1", color: "#e2167e",
    models: ["MiniMax-M2"], keyUrl: "https://www.minimax.io/platform" },
  { id: "together", name: "Together AI", kind: "apikey", format: "openai", baseUrl: "https://api.together.xyz/v1", color: "#0f6fff",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8", "deepseek-ai/DeepSeek-V3.1"], keyUrl: "https://api.together.ai/settings/api-keys" },
  { id: "fireworks", name: "Fireworks AI", kind: "apikey", format: "openai", baseUrl: "https://api.fireworks.ai/inference/v1", color: "#7c3aed",
    models: ["accounts/fireworks/models/deepseek-v3p1", "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct"], keyUrl: "https://fireworks.ai/account/api-keys" },
  { id: "chutes", name: "Chutes AI", kind: "apikey", format: "openai", baseUrl: "https://llm.chutes.ai/v1", color: "#22c55e",
    models: ["deepseek-ai/DeepSeek-V3.1", "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8"], keyUrl: "https://chutes.ai/app/api" },
  { id: "featherless", name: "Featherless", kind: "apikey", format: "openai", baseUrl: "https://api.featherless.ai/v1", color: "#a855f7",
    models: ["deepseek-ai/DeepSeek-V3-0324", "Qwen/Qwen2.5-Coder-32B-Instruct"], keyUrl: "https://featherless.ai/account/api-keys" },
  { id: "perplexity", name: "Perplexity", kind: "apikey", format: "openai", baseUrl: "https://api.perplexity.ai", color: "#20b8cd",
    models: ["sonar", "sonar-pro", "sonar-reasoning"], keyUrl: "https://www.perplexity.ai/settings/api" },
  { id: "siliconflow", name: "SiliconFlow", kind: "apikey", format: "openai", baseUrl: "https://api.siliconflow.com/v1", color: "#8b5cf6",
    models: ["deepseek-ai/DeepSeek-V3.1", "Qwen/Qwen3-Coder-480B-A35B-Instruct"], keyUrl: "https://cloud.siliconflow.com/account/ak" },
  { id: "cohere", name: "Cohere", kind: "apikey", format: "openai", baseUrl: "https://api.cohere.ai/compatibility/v1", color: "#39594d",
    models: ["command-a-03-2025", "command-r-plus"], keyUrl: "https://dashboard.cohere.com/api-keys" },
];

export const SECTIONS: { kind: Kind; title: string }[] = [
  { kind: "oauth", title: "OAuth Providers" },
  { kind: "free", title: "Free Tier Providers" },
  { kind: "apikey", title: "API Key Providers" },
];

export function findEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}
