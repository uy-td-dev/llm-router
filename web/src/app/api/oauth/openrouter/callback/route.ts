import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { openrouterCallback } from "@/lib/oauth";

export async function GET(req: NextRequest) {
  const s = await getSession();
  if (s?.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const flow = req.nextUrl.searchParams.get("flow") ?? "";
  const code = req.nextUrl.searchParams.get("code") ?? "";
  const back = new URL("/providers", process.env.WEB_PUBLIC_URL || req.nextUrl.origin);
  try {
    await openrouterCallback(flow, code);
    back.searchParams.set("connected", "openrouter");
  } catch (e) {
    back.searchParams.set("error", String(e).slice(0, 200));
  }
  return NextResponse.redirect(back);
}
