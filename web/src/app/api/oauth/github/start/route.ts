import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { githubStart } from "@/lib/oauth";

export async function POST() {
  const s = await getSession();
  if (s?.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    return NextResponse.json(await githubStart());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
