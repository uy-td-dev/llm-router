import { NextRequest, NextResponse } from "next/server";
import {
  createUser,
  createSessionToken,
  SESSION_COOKIE,
} from "@/lib/auth";

/** Self-serve registration: creates role=user, logs the user in immediately. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { username?: string; password?: string; displayName?: string }
    | null;
  const username = body?.username?.trim() || "";
  const password = body?.password || "";
  if (!username || !password) {
    return NextResponse.json({ error: "Thiếu username/password" }, { status: 400 });
  }

  const result = createUser(username, password, body?.displayName);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  const token = await createSessionToken(result.user);
  const res = NextResponse.json({ user: result.user }, { status: 201 });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  return res;
}
