import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { routerFetch } from "@/lib/router";
import { forgetGithub, disconnectClaude } from "@/lib/oauth";

/** Disconnect one account (or the whole provider when label is omitted). */
export async function POST(req: NextRequest) {
  const s = await getSession();
  if (s?.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { provider, label } = (await req.json().catch(() => ({}))) as { provider?: string; label?: string };
  if (!provider) return NextResponse.json({ error: "missing provider" }, { status: 400 });
  const p = encodeURIComponent(provider);
  const path = label ? `/admin/connections/${p}/accounts/${encodeURIComponent(label)}` : `/admin/connections/${p}`;
  const res = await routerFetch(path, { method: "DELETE" });
  if (provider === "github-copilot" && label) forgetGithub(label);
  if (provider === "claude-code") {
    if (label) await disconnectClaude(label);
    else {
      // Remove all Claude accounts
      const { claudeAccounts, writeClaudeAccounts } = await import("@/lib/oauth");
      for (const acc of claudeAccounts()) {
        try { await disconnectClaude(acc.label); } catch {}
      }
      writeClaudeAccounts([]);
    }
  }
  return new NextResponse(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
}
