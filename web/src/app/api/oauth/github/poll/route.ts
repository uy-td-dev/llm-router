import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { githubPoll } from "@/lib/oauth";

export async function POST(req: NextRequest) {
  const s = await getSession();
  if (s?.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { flow } = (await req.json().catch(() => ({}))) as { flow?: string };
  if (!flow) return NextResponse.json({ error: "missing flow" }, { status: 400 });
  try {
    return NextResponse.json(await githubPoll(flow));
  } catch (e) {
    return NextResponse.json({ status: "error", error: String(e) });
  }
}
