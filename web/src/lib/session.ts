import { SignJWT, jwtVerify } from "jose";

export type Role = "admin" | "team_lead" | "user";

export interface SessionUser {
  username: string;
  role: Role;
  displayName: string;
  /** Team id the user belongs to. Null for admins / unassigned users. */
  team: string | null;
}

/** Edge-safe: JWT session helpers only (no fs/path/crypto-node here). */
export const SESSION_COOKIE = "dash_session";

function secret(): Uint8Array {
  const s = process.env.AUTH_SECRET || "dev-secret-change-me";
  return new TextEncoder().encode(s);
}

export async function createSessionToken(user: SessionUser): Promise<string> {
  return new SignJWT({ user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(secret());
}

export async function verifySessionToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    const user = payload.user as SessionUser | undefined;
    if (!user?.username) return null;
    // Old tokens (pre-teams) have no team field; default to null so they
    // keep working for the same role.
    return { ...user, team: user.team ?? null };
  } catch {
    return null;
  }
}
