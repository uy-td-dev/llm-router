export interface TestResult {
  ok: boolean;
  model?: string;
  reply?: string;
  latency_ms?: number;
  usage?: { prompt_tokens: number; completion_tokens: number };
  error?: string | { message?: string };
}

export function describeTest(r: TestResult): string {
  if (r.ok) {
    return `✓ ${r.model} trả lời "${(r.reply ?? "").trim().slice(0, 60)}" — ${r.latency_ms}ms, ${
      (r.usage?.prompt_tokens ?? 0) + (r.usage?.completion_tokens ?? 0)
    } tokens`;
  }
  const msg = typeof r.error === "string" ? r.error : r.error?.message;
  return `✗ ${msg ?? "lỗi không rõ"}`;
}
