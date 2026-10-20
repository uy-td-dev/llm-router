import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

/**
 * GET /api/oauth/claude/poll
 * Returns the result of the Claude OAuth exchange (or pending/error).
 */
export async function GET() {
  const s = await getSession();
  if (s?.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const g = globalThis as unknown as { __claudeResult?: { label?: string; email?: string; error?: string } };
  const result = g.__claudeResult;

  if (!result) {
    return NextResponse.json({ status: "pending" });
  }
  if (result.error) {
    return NextResponse.json({ status: "error", error: result.error });
  }
  return NextResponse.json({
    status: "connected",
    label: result.label,
    email: result.email,
  });
}
