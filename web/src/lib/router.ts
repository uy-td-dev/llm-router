/**
 * Server-side fetch helpers for the upstream llm-router (Rust).
 * Never import from client components — these read ADMIN_API_KEY from env.
 */

export function routerUrl(): string {
  return process.env.ROUTER_URL || "http://localhost:8080";
}

export function adminKey(): string | undefined {
  return process.env.ADMIN_API_KEY || undefined;
}

export async function routerFetch(
  path: string,
  init?: RequestInit & { admin?: boolean }
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.admin !== false && adminKey()) headers["X-Admin-Key"] = adminKey()!;
  return fetch(`${routerUrl()}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
}
