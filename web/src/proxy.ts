import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE, type Role } from "@/lib/session";

const PUBLIC_PAGES = ["/login", "/register"];
const PUBLIC_APIS = ["/api/auth/login", "/api/auth/register"];

const ALL: Role[] = ["admin", "team_lead", "user"];
const STAFF: Role[] = ["admin", "team_lead"];

/**
 * Page access by role. Longest matching prefix wins; pages not listed here
 * (and not in ALL_PAGES_LITE) are admin-only, so a newly added page can never
 * leak to scoped roles by accident.
 */
const PAGE_ROLES: { prefix: string; roles: Role[] }[] = [
  { prefix: "/endpoint", roles: ALL },
  { prefix: "/keys", roles: ALL },
  { prefix: "/usage", roles: ALL },
  { prefix: "/providers", roles: STAFF },
  { prefix: "/teams", roles: STAFF },
];

function pageAllowed(role: Role, pathname: string): boolean {
  const hit = PAGE_ROLES.filter((r) => pathname === r.prefix || pathname.startsWith(r.prefix + "/"))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return hit ? hit.roles.includes(role) : role === "admin";
}

/** Landing page for a role after login / on a denied page. */
export function homeFor(role: Role): string {
  return role === "admin" ? "/dash" : "/endpoint";
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt"
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;

  // API: public login route + everything else requires a session
  if (pathname.startsWith("/api/")) {
    if (PUBLIC_APIS.some((p) => pathname.startsWith(p))) {
      return NextResponse.next();
    }
    if (!session) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    return NextResponse.next();
  }

  // Pages: login always allowed, everything else redirects to it
  if (PUBLIC_PAGES.some((p) => pathname.startsWith(p))) {
    if (session) return NextResponse.redirect(new URL(homeFor(session.role), req.url));
    return NextResponse.next();
  }

  if (!session) {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Role gate: bounce unauthorized pages to the role's home instead of
  // letting the page render (its BFF calls would 403 anyway).
  if (pathname !== "/" && !pageAllowed(session.role, pathname)) {
    return NextResponse.redirect(new URL(homeFor(session.role), req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
