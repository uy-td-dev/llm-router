import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { claudeAccounts, fetchClaudeUsage } from "@/lib/oauth";

/**
 * GET /api/oauth/claude/usage
 * Returns current Claude OAuth account(s) with their usage snapshots.
 */
export async function GET() {
  const s = await getSession();
  if (s?.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const accounts = claudeAccounts();
  const results = [];
  for (const acc of accounts) {
    const usage = await fetchClaudeUsage(acc);
    results.push({
      label: acc.label,
      email: acc.email ?? null,
      orgId: acc.orgId ?? null,
      expiresAt: acc.expiresAt,
      usage: usage ?? acc.usage ?? null,
    });
  }
  return NextResponse.json({ accounts: results });
}
