import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { openrouterStart } from "@/lib/oauth";

export async function GET(req: NextRequest) {
  const s = await getSession();
  if (s?.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const origin = process.env.WEB_PUBLIC_URL || req.nextUrl.origin;
  return NextResponse.redirect(openrouterStart(origin));
}
