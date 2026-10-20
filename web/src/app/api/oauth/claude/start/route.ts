import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { claudeStart, claudeExchange } from "@/lib/oauth";

/**
 * POST /api/oauth/claude/start
 * Starts the Claude OAuth PKCE flow with a local callback server.
 * Returns the authorize URL for the browser. The exchange happens in the
 * background when the callback arrives; poll /poll to check status.
 */
export async function POST() {
  const s = await getSession();
  if (s?.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  try {
    const { url, wait, verifier, redirectUri } = await claudeStart();

    // Fire-and-forget: exchange tokens when callback resolves
    const g = globalThis as unknown as { __claudeResult?: { label?: string; email?: string; error?: string } };
    g.__claudeResult = undefined; // reset previous result
    wait.then(({ code, state }) => {
      return claudeExchange(code, state, verifier, redirectUri);
    }).then((result) => {
      g.__claudeResult = { label: result.label, email: result.email };
    }).catch((e: Error) => {
      g.__claudeResult = { error: String(e) };
    });

    return NextResponse.json({ url });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
