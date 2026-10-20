import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { routerFetch } from "@/lib/router";

/**
 * Streaming chat proxy: browser -> here -> llm-router /v1/chat/completions.
 * Passes the SSE/text stream straight through; no admin key involved
 * (the router-side client-key auth, when enabled, is provided via
 * VIRTUAL_KEY env so the browser never holds it either).
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  // The playground runs on a shared VIRTUAL_KEY (global model surface), so it
  // stays admin-only — a team member must not reach other teams' models.
  if (session.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.text();

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: req.headers.get("accept") || "*/*",
  };
  const virtualKey = process.env.VIRTUAL_KEY;
  if (virtualKey) headers["authorization"] = `Bearer ${virtualKey}`;

  const upstream = await routerFetch("/v1/chat/completions", {
    method: "POST",
    headers,
    body,
  });

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-cache",
    },
  });
}
