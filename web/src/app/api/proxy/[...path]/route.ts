import { NextRequest, NextResponse } from "next/server";
import { getSession, listUsers, type Role, type SessionUser } from "@/lib/auth";
import { routerFetch } from "@/lib/router";

/**
 * BFF: browser -> /api/proxy/<llm-router path> -> Rust server.
 * The ADMIN_API_KEY lives only server-side; the browser can never reach the
 * admin API directly nor see the key.
 *
 * RBAC (dashboard session role):
 *   - admin: everything (unscoped).
 *   - team_lead: their team's keys/connections/usage; may create keys for
 *     their own members, manage their own team's providers, read scoped
 *     usage/history/requests.
 *   - user: own keys only (create/delete), own usage, /v1/models, /health.
 *
 * Scoping is enforced here (response filtering + forced body fields); the
 * data plane is enforced in Rust by team-restricted virtual keys.
 */

type Action = "deny" | "forward" | "scope";

const SCOPED_KEYS = "/admin/keys";
const SCOPED_CONN = "/admin/connections";
const SCOPED_PROVIDERS = "/admin/providers";
const SCOPED_USAGE = "/admin/usage";
const SCOPED_REQ = "/admin/requests";
const SCOPED_HIST = "/admin/history";

function connSub(p: string): string {
  const rest = p.slice(SCOPED_CONN.length);
  if (rest === "") return "list";
  const segs = rest.split("?")[0].split("/").filter(Boolean);
  // /admin/connections/test | /models | /{name} | /{name}/accounts/{label}
  if (segs[0] === "test") return "test";
  if (segs[0] === "models") return "models";
  if (segs[1] === "accounts") return "account";
  return "name";
}

function keySub(p: string): string {
  const rest = p.slice(SCOPED_KEYS.length);
  if (rest === "") return "list";
  const seg = rest.split("?")[0].split("/")[1] || "";
  if (seg === "delete") return "delete";
  return "id";
}

/**
 * Role-aware decision for a proxied admin path. Everything not listed here
 * (stats, config, combos, quotas, proxies, token-saver, vision, skills,
 * system, logs, providers) is admin-only.
 */
function decide(role: Role, rawPath: string, method: string): Action {
  const path = rawPath.split("?")[0];
  const get = method === "GET";

  // Admins pass everything — the dash/usage/keys/providers/config/... pages
  // all hit /admin/* endpoints and rely on this. (scopedProxy forwards them
  // untouched; the admin key is attached server-side by routerFetch.)
  if (role === "admin") return "forward";

  if (path.startsWith("/health") || (path.startsWith("/v1/models") && get)) return "forward";
  if (path.startsWith("/admin/persistence") && get) return "forward";
  // Upstream account pool = every team's credentials; admin only.
  if (path.startsWith("/admin/accounts")) return "deny";

  // Virtual keys
  if (path.startsWith(SCOPED_KEYS)) {
    if (role === "team_lead") return "forward";
    if (role === "user") {
      const sub = keySub(path);
      if (sub === "list" && get) return "scope";
      if (sub === "delete" && method === "POST") return "scope";
      if (sub === "list" && method === "POST") return "scope";
      // Editing an existing key (model/provider allow-lists) is team-lead+
      return "deny";
    }
    return "deny";
  }

  // Connections (providers) + runtime provider pool: leads are scoped in the
  // handler below (per-connection team checks).
  if (path.startsWith(SCOPED_CONN) || path.startsWith(SCOPED_PROVIDERS)) {
    if (role === "team_lead") return "forward";
    return "deny"; // user never sees providers
  }

  // Usage / requests / history
  if (path.startsWith(SCOPED_USAGE) && get) return "scope";
  if (path.startsWith(SCOPED_REQ) && get) return "scope";
  if (path.startsWith(SCOPED_HIST) && get) return "scope";
  // Monitor insights: same scoping as usage (team for leads, owner for users).
  if (path.startsWith("/admin/insights") && get) return "scope";

  return "deny";
}

/** Merge `extra` query params into the upstream path. */
function withParams(path: string, extra: Record<string, string>): string {
  const [base, search] = path.split("?");
  const usp = new URLSearchParams(search);
  for (const [k, v] of Object.entries(extra)) usp.set(k, v);
  const q = usp.toString();
  return q ? `${base}?${q}` : base;
}

function deny(detail: string): NextResponse {
  return NextResponse.json({ error: `forbidden: ${detail}` }, { status: 403 });
}

function badRequest(detail: string): NextResponse {
  return NextResponse.json({ error: detail }, { status: 400 });
}

/** Team membership of a username (server-side lookup, session cannot lie). */
function isMemberOf(session: SessionUser, username: string): boolean {
  if (session.role === "admin") return true;
  if (!session.team) return false;
  const u = listUsers().find((x) => x.username === username);
  return !!u && u.team === session.team;
}

async function forward(path: string, method: string, body?: string, headers?: Record<string, string>): Promise<NextResponse> {
  const init: RequestInit = { method };
  const h: Record<string, string> = { ...(headers || {}) };
  const ct = headers?.["content-type"];
  if (ct) init.headers = h;
  if (body !== undefined) init.body = body;
  try {
    const upstream = await routerFetch(path, init);
    const contentType = upstream.headers.get("content-type") || "application/json";
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "content-type": contentType },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `llm-router không phản hồi: ${String(e)}` },
      { status: 502 }
    );
  }
}

/** Find a virtual key by (masked or plain) label within one owner's keys. */
function findOwnKey(keys: any[], key: string): any | undefined {
  return keys.find((k) => k.key === key || k.key_plain === key);
}

async function scopedProxy(req: NextRequest, session: SessionUser, method: string): Promise<NextResponse> {
  const raw = req.nextUrl.pathname.replace(/^\/api\/proxy/, "") + req.nextUrl.search;
  const path = raw.split("?")[0];
  const action = decide(session.role, raw, method);
  if (action === "deny") return deny(`role '${session.role}' không có quyền trên ${path}`);
  const get = method === "GET";
  const charset = req.headers.get("content-type");
  const body = method !== "GET" ? await req.text() : undefined;
  // Admins are never scoped: everything decide() allowed goes straight to
  // the router untouched (keys/connections/usage/config/stats...).
  if (session.role === "admin") {
    return forward(raw, method, body, charset ? { "content-type": charset } : undefined);
  }

  // ---- /v1/models: non-admins see what their own key may call ----
  if (path.startsWith("/v1/models") && get) {
    const res = await routerFetch("/admin/keys");
    const data = (await res.json().catch(() => null)) as { keys?: any[] } | null;
    const mine = (data?.keys || []).find((k: any) => k.owner === session.username && k.is_active !== false);
    if (!mine) {
      return NextResponse.json({ data: [], note: "Tạo API key để xem các model được phép" }, {
        headers: { "content-type": "application/json" },
      });
    }
    const m = await routerFetch("/v1/models", {
      // Must NOT carry the admin key: middleware treats a valid admin key on
      // non-admin routes as full anonymous access, which would bypass the
      // key's team/provider restrictions.
      admin: false,
      headers: { authorization: `Bearer ${mine.key_plain}` },
    });
    const text = await m.text();
    return new NextResponse(text, {
      status: m.status,
      headers: { "content-type": m.headers.get("content-type") || "application/json" },
    });
  }

  // ---- scoped usage / requests / history: append owner or team filter ----
  if (
    (path.startsWith(SCOPED_USAGE) ||
      path.startsWith(SCOPED_REQ) ||
      path.startsWith(SCOPED_HIST) ||
      path.startsWith("/admin/insights")) &&
    get
  ) {
    const extra: Record<string, string> =
      session.role === "team_lead" ? { team: session.team || "" } : { owner: session.username };
    return forward(withParams(raw, extra), method);
  }

  // ---- keys ----
  if (path.startsWith(SCOPED_KEYS)) {
    const sub = keySub(path);

    // List: filter rows by scope
    if (sub === "list" && get) {
      const res = await forward(raw, method);
      if (res.status !== 200) return res;
      const data = await res.json().catch(() => null);
      if (!data || !Array.isArray(data.keys)) return res;
      const keys = session.role === "team_lead"
        ? data.keys.filter((k: any) => k.team === session.team)
        : data.keys.filter((k: any) => k.owner === session.username);
      return NextResponse.json({ ...data, keys, count: keys.length, scoped: true });
    }

    // Create (user: own key; team_lead: own team, member-owned)
    if (sub === "list" && method === "POST") {
      let parsed: any = null;
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        return badRequest("JSON không hợp lệ");
      }
      if (session.role === "user") {
        if (!session.team) return badRequest("Bạn chưa được gán vào team — liên hệ admin");
        // Users get a key on the whole team's models; narrowing is team-lead work.
        const key = parsed?.key || randomKey();
        if (!isMemberOf(session, session.username)) return deny("không có team");
        const payload = {
          key,
          owner: session.username,
          team: session.team,
          allowed_models: ["*"],
          rpm: parsed?.rpm ?? null,
          monthly_budget_usd: parsed?.monthly_budget_usd ?? null,
        };
        return forward(SCOPED_KEYS, "POST", JSON.stringify(payload), { "content-type": "application/json" });
      }
      // team_lead
      if (!session.team) return deny("team lead chưa có team");
      const owner = String(parsed?.owner || session.username);
      if (!isMemberOf(session, owner)) return deny(`user '${owner}' không thuộc team của bạn`);
      const payload = {
        ...parsed,
        team: session.team,
        owner,
        key: parsed?.key || randomKey(),
      };
      return forward(SCOPED_KEYS, "POST", JSON.stringify(payload), { "content-type": "application/json" });
    }

    // Delete: verify the key belongs to the scope first
    if (sub === "delete" && method === "POST") {
      let parsed: any = null;
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        return badRequest("JSON không hợp lệ");
      }
      const target = String(parsed?.key || "");
      if (!target) return badRequest("thiếu 'key'");
      const listRes = await forward(SCOPED_KEYS, "GET");
      const list = (await listRes.json().catch(() => null)) as { keys?: any[] } | null;
      const keys = list?.keys || [];
      const hit = findOwnKey(
        keys.filter((k) => (session.role === "team_lead" ? k.team === session.team : k.owner === session.username)),
        target,
      );
      if (!hit) return deny("key không thuộc phạm vi của bạn");
      return forward(raw, "POST", JSON.stringify({ key: hit.key_plain || hit.key }), { "content-type": "application/json" });
    }

    return deny(`role '${session.role}' không có quyền ${method} ${path}`);
  }

  // ---- connections (team_lead: scoped to own team) ----
  if (path.startsWith(SCOPED_CONN)) {
    const sub = connSub(path);

    if (get && sub === "list") {
      const res = await forward(raw, method);
      if (res.status !== 200) return res;
      const data = await res.json().catch(() => null);
      if (!data) return res;
      const team = session.team;
      const connections = Array.isArray(data.connections)
        ? data.connections.filter((c: any) => c.team === team)
        : [];
      // The live provider list has no team field: keep only the registry
      // entries whose connection belongs to this team.
      const names = new Set(connections.map((c: any) => c.name));
      const providers = Array.isArray(data.providers)
        ? data.providers.filter((p: any) => names.has(p.name))
        : [];
      return NextResponse.json({ ...data, connections, providers, scoped: true });
    }

    if (!session.team) return deny("team lead chưa có team");

    // Add / replace a connection: forced into the lead's own team. A name
    // already owned by another team (or a global/admin connection) may not be
    // taken over — connection names are instance-unique.
    if (method === "POST" && sub === "list") {
      let parsed: any = null;
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        return badRequest("JSON không hợp lệ");
      }
      const name = String(parsed?.name || "");
      if (!name) return badRequest("thiếu 'name'");
      const owner = await connectionTeam(name);
      if (owner !== undefined && owner !== session.team) {
        return deny(`provider '${name}' đã thuộc ${owner ? `team '${owner}'` : "cấu hình toàn cục"}`);
      }
      const payload = { ...parsed, team: session.team };
      return forward(SCOPED_CONN, "POST", JSON.stringify(payload), { "content-type": "application/json" });
    }

    // Per-account mutations on an existing connection of the team.
    if ((method === "POST" || method === "PATCH" || method === "PUT") && sub === "account") {
      const name = path.split("/")[3] || "";
      if (!(await connectionInTeam(name, session.team))) {
        return deny(`provider '${name}' không thuộc team của bạn`);
      }
      return forward(raw, method, body, charset ? { "content-type": charset } : undefined);
    }

    // Test / fetch models of an unsaved definition (form builder).
    if (method === "POST" && (sub === "test" || sub === "models")) {
      return forward(raw, "POST", body, charset ? { "content-type": charset } : undefined);
    }

    // Delete a connection or one of its accounts.
    if (method === "DELETE") {
      const name = path.split("/")[3] || "";
      if (!(await connectionInTeam(name, session.team))) {
        return deny(`provider '${name}' không thuộc team của bạn`);
      }
      return forward(raw, method);
    }

    return deny(`role '${session.role}' không có quyền ${method} ${path}`);
  }

  // ---- /admin/providers/{id}/… (runtime pool + tests) ----
  if (path.startsWith(SCOPED_PROVIDERS)) {
    if (!session.team) return deny("team lead chưa có team");
    const segs = path.split("/").filter(Boolean); // [admin, providers, id, …]
    const id = segs[2] || "";
    const verb = segs[3] || "";
    if (!(await connectionInTeam(id, session.team))) {
      return deny(`provider '${id}' không thuộc team của bạn`);
    }
    if (get && verb === "accounts") return forward(raw, method);
    if (method === "POST" && verb === "test") return forward(raw, "POST", body, charset ? { "content-type": charset } : undefined);
    return deny(`role '${session.role}' không có quyền ${method} ${path}`);
  }

  return deny(`role '${session.role}' không có quyền ${method} ${path}`);
}

/** Team owning a connection name; undefined when the name is unknown. */
async function connectionTeam(name: string): Promise<string | null | undefined> {
  const res = await routerFetch("/admin/connections");
  const data = (await res.json().catch(() => null)) as { connections?: any[] } | null;
  const hit = data?.connections?.find((c: any) => c.name === name);
  return hit ? hit.team ?? null : undefined;
}

async function connectionInTeam(name: string, team: string): Promise<boolean> {
  return (await connectionTeam(name)) === team;
}

function randomKey(): string {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return "sk-vk-" + Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function GET(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  return scopedProxy(req, s, "GET");
}
export async function POST(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  return scopedProxy(req, s, "POST");
}
export async function DELETE(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  return scopedProxy(req, s, "DELETE");
}
export async function PUT(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  return scopedProxy(req, s, "PUT");
}
export async function PATCH(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  return scopedProxy(req, s, "PATCH");
}
