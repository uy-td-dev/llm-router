import { NextRequest, NextResponse } from "next/server";
import {
  verifyCredentials,
  createSessionToken,
  SESSION_COOKIE,
} from "@/lib/auth";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { username?: string; password?: string }
    | null;
  const username = body?.username?.trim();
  const password = body?.password || "";
  if (!username || !password) {
    return NextResponse.json({ error: "Thiếu username/password" }, { status: 400 });
  }

  const user = verifyCredentials(username, password);
  if (!user) {
    return NextResponse.json({ error: "Sai username hoặc password" }, { status: 401 });
  }

  const token = await createSessionToken(user);
  const res = NextResponse.json({ user });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  return res;
}
