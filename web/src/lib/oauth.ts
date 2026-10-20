/**
 * Server-only OAuth helpers for dashboard "Connect" flows.
 *  - GitHub Copilot: GitHub device-code login → long-lived GitHub token
 *    (stored in data/oauth.json) → short-lived Copilot API token pushed to
 *    the router as the account credential, refreshed before expiry.
 *  - OpenRouter: official OAuth PKCE → permanent API key.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { routerFetch } from "@/lib/router";
import { findEntry } from "@/lib/catalog";

const STORE = path.join(process.cwd(), "data", "oauth.json");

export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const COPILOT_HEADERS: Record<string, string> = {
  "Editor-Version": "vscode/1.99.0",
  "Editor-Plugin-Version": "copilot-chat/0.26.0",
  "Copilot-Integration-Id": "vscode-chat",
  "User-Agent": "GitHubCopilotChat/0.26.0",
};

interface GithubAccount {
  label: string;
  githubToken: string;
  login: string;
  copilotExpiresAt?: number;
}

interface ClaudeAccount {
  label: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  orgId?: string;
  email?: string;
  /** Last usage snapshot fetched from Anthropic's OAuth usage endpoint. */
  usage?: { fiveHour?: { utilization?: number; resetsAt?: string }; sevenDay?: { utilization?: number; resetsAt?: string } };
}

interface Store {
  github: GithubAccount[];
  claude?: ClaudeAccount[];
}

function readStore(): Store {
  try {
    return { github: [], ...JSON.parse(fs.readFileSync(STORE, "utf8")) };
  } catch {
    return { github: [] };
  }
}

function writeStore(s: Store) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  const tmp = `${STORE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STORE);
}

// ---- short-lived pending flows (per server process) ----
type Pending =
  | { kind: "github"; deviceCode: string; interval: number; expires: number }
  | { kind: "openrouter"; verifier: string; expires: number };

const g = globalThis as unknown as { __oauthPending?: Map<string, Pending>; __oauthTimer?: NodeJS.Timeout };
const pending: Map<string, Pending> = (g.__oauthPending ??= new Map());

function putPending(p: Pending): string {
  const id = crypto.randomBytes(16).toString("hex");
  for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
  pending.set(id, p);
  return id;
}

async function saveConnection(body: unknown) {
  const res = await routerFetch("/admin/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`router: ${res.status} ${await res.text()}`);
}

// ======================= GitHub Copilot =======================

export async function githubStart() {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: "read:user" }),
  });
  if (!res.ok) throw new Error(`GitHub device code: ${res.status}`);
  const d = (await res.json()) as {
    device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number;
  };
  const flow = putPending({
    kind: "github",
    deviceCode: d.device_code,
    interval: d.interval,
    expires: Date.now() + d.expires_in * 1000,
  });
  return { flow, user_code: d.user_code, verification_uri: d.verification_uri, interval: d.interval, expires_in: d.expires_in };
}

async function copilotToken(githubToken: string) {
  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: { authorization: `token ${githubToken}`, accept: "application/json", ...COPILOT_HEADERS },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(
      res.status === 404 || res.status === 403
        ? `Tài khoản GitHub này chưa có Copilot (bật Copilot Free tại github.com/settings/copilot). ${t.slice(0, 120)}`
        : `Copilot token: ${res.status} ${t.slice(0, 200)}`
    );
  }
  const d = (await res.json()) as { token: string; expires_at: number; endpoints?: { api?: string } };
  return { token: d.token, expiresAt: d.expires_at * 1000, api: d.endpoints?.api || "https://api.githubcopilot.com" };
}

async function copilotModels(api: string, token: string): Promise<string[]> {
  try {
    const res = await fetch(`${api}/models`, {
      headers: { authorization: `Bearer ${token}`, ...COPILOT_HEADERS },
    });
    if (!res.ok) return [];
    const d = (await res.json()) as {
      data: { id: string; capabilities?: { type?: string }; model_picker_enabled?: boolean }[];
    };
    return d.data
      .filter((m) => (m.capabilities?.type ?? "chat") === "chat" && m.model_picker_enabled !== false)
      .map((m) => m.id);
  } catch {
    return [];
  }
}

/** Exchange + push one GitHub account's Copilot token to the router. */
async function syncCopilot(acc: GithubAccount, models?: string[]) {
  const ct = await copilotToken(acc.githubToken);
  const list = models ?? (await copilotModels(ct.api, ct.token));
  const entry = findEntry("github-copilot")!;
  await saveConnection({
    name: entry.id,
    format: entry.format,
    base_url: ct.api,
    headers: COPILOT_HEADERS,
    models: (list.length ? list : ["gpt-4o", "gpt-4.1"]).map((name) => ({ name })),
    accounts: [{ label: acc.label, api_key: ct.token, priority: 100, weight: 1 }],
    prefix: "gh",
    merge: true,
  });
  acc.copilotExpiresAt = ct.expiresAt;
  return list;
}

export async function githubPoll(flow: string) {
  const p = pending.get(flow);
  if (!p || p.kind !== "github") return { status: "expired" as const };
  if (p.expires < Date.now()) {
    pending.delete(flow);
    return { status: "expired" as const };
  }
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      device_code: p.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const d = (await res.json()) as { access_token?: string; error?: string; interval?: number };
  if (d.error === "authorization_pending") return { status: "pending" as const };
  if (d.error === "slow_down") {
    p.interval = d.interval ?? p.interval + 5;
    return { status: "pending" as const, interval: p.interval };
  }
  if (!d.access_token) {
    pending.delete(flow);
    return { status: "error" as const, error: d.error ?? "unknown" };
  }
  pending.delete(flow);

  const user = await fetch("https://api.github.com/user", {
    headers: { authorization: `token ${d.access_token}`, "user-agent": "llm-router" },
  }).then((r) => r.json() as Promise<{ login?: string }>);
  const login = user.login ?? "github";
  const acc: GithubAccount = { label: `gh-${login}`, githubToken: d.access_token, login };

  const models = await syncCopilot(acc);
  const store = readStore();
  store.github = store.github.filter((a) => a.label !== acc.label).concat(acc);
  writeStore(store);
  return { status: "connected" as const, label: acc.label, models };
}

export function forgetGithub(label: string) {
  const store = readStore();
  store.github = store.github.filter((a) => a.label !== label);
  writeStore(store);
}

/** Refresh Copilot tokens expiring within 5 minutes (or all on boot). */
export async function refreshAll(force = false) {
  const store = readStore();
  if (!store.github.length) return;
  let changed = false;
  for (const acc of store.github) {
    if (!force && acc.copilotExpiresAt && acc.copilotExpiresAt - Date.now() > 5 * 60_000) continue;
    try {
      await syncCopilot(acc);
      changed = true;
      console.log(`[oauth] Copilot token refreshed for ${acc.label}`);
    } catch (e) {
      console.warn(`[oauth] Copilot refresh failed for ${acc.label}: ${String(e)}`);
    }
  }
  if (changed) writeStore(store);
}

// ======================= OpenRouter (PKCE) =======================

export function openrouterStart(origin: string) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const flow = putPending({ kind: "openrouter", verifier, expires: Date.now() + 10 * 60_000 });
  const callback = `${origin}/api/oauth/openrouter/callback?flow=${flow}`;
  const url = new URL("https://openrouter.ai/auth");
  url.searchParams.set("callback_url", callback);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function openrouterCallback(flow: string, code: string) {
  const p = pending.get(flow);
  if (!p || p.kind !== "openrouter" || p.expires < Date.now()) throw new Error("Phiên OAuth đã hết hạn — thử lại.");
  pending.delete(flow);
  const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: p.verifier, code_challenge_method: "S256" }),
  });
  if (!res.ok) throw new Error(`OpenRouter: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const { key } = (await res.json()) as { key: string };
  const entry = findEntry("openrouter")!;
  await saveConnection({
    name: entry.id,
    format: entry.format,
    base_url: entry.baseUrl,
    models: entry.models.map((name) => ({ name })),
    accounts: [{ label: `openrouter-${Date.now().toString(36)}`, api_key: key, priority: 50, weight: 1 }],
    prefix: "or",
    merge: true,
  });
}

// ======================= Claude Code (Anthropic OAuth PKCE) =======================

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLAUDE_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const CLAUDE_SCOPES = ["org:create_api_key", "user:profile", "user:inference"];
const CLAUDE_BASE_URL = "https://api.anthropic.com/v1";
const CLAUDE_MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-4-5", "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5", "claude-haiku-4-5-20251001",
];

/** Read Claude OAuth account(s) from the shared store. */
export function claudeAccounts(): ClaudeAccount[] {
  return readStore().claude ?? [];
}

/** Write Claude account(s) back to the shared store. */
export function writeClaudeAccounts(accounts: ClaudeAccount[]) {
  const store = readStore();
  store.claude = accounts;
  writeStore(store);
}

// ---- Claude local callback server (loopback only, per Anthropic policy) ----
import http from "node:http";

interface ClaudeFlow {
  verifier: string;
  redirectUri: string;
  resolve: (code: string, state: string) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const gClaude = globalThis as unknown as {
  __claudeServer?: http.Server;
  __claudePort?: number;
  __claudeFlow?: ClaudeFlow;
  /** Result of the last completed exchange (for polling). */
  __claudeResult?: { label?: string; email?: string; error?: string };
};

/** Start (once) a loopback HTTP server that receives the Claude OAuth callback. */
function startClaudeCallbackServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    if (gClaude.__claudePort) {
      resolve(gClaude.__claudePort);
      return;
    }
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const code = url.searchParams.get("code") || "";
      const state = url.searchParams.get("state") || "";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Claude Connected</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5}
.container{text-align:center;padding:2rem;background:white;border-radius:8px}
.success{color:#22c55e;font-size:3rem}h1{margin:1rem 0;color:#333;font-size:1.2rem}p{color:#666}</style></head>
<body><div class="container"><div class="success">✓</div><h1>Claude Connected</h1>
<p>You can close this tab and return to the dashboard.</p></div></body></html>`);
      const flow = gClaude.__claudeFlow;
      if (flow) {
        clearTimeout(flow.timer);
        gClaude.__claudeFlow = undefined;
        flow.resolve(code, state);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      gClaude.__claudeServer = server;
      gClaude.__claudePort = port;
      resolve(port);
    });
    server.on("error", reject);
  });
}

/**
 * Start the Claude OAuth flow: PKCE pair + local callback server + authorize URL.
 * Returns the URL to open in the browser and a promise that resolves when the
 * user completes authorization (or rejects on timeout/error).
 */
export function claudeStart() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");

  return startClaudeCallbackServer().then((port) => {
    const redirectUri = `http://localhost:${port}/callback`;
    const params = new URLSearchParams({
      code: "true",
      client_id: CLAUDE_CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: CLAUDE_SCOPES.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });
    const wait = new Promise<{ code: string; state: string }>((resolve) => {
      const timer = setTimeout(() => {
        if (gClaude.__claudeFlow) {
          gClaude.__claudeFlow = undefined;
          gClaude.__claudeResult = { error: "Authentication timeout (10 minutes)" };
          resolve({ code: "", state: "" });
        }
      }, 10 * 60_000);
      gClaude.__claudeFlow = {
        verifier,
        redirectUri,
        resolve: (code, state) => {
          resolve({ code, state });
        },
        reject: () => {},
        timer,
      };
    });
    return { url: `${CLAUDE_AUTHORIZE_URL}?${params}`, state, wait, port, verifier, redirectUri };
  });
}

/**
 * Exchange the Claude authorization code for tokens, fetch profile info,
 * push the connection to the router and save the account for refresh.
 */
export async function claudeExchange(code: string, state: string, verifier: string, redirectUri: string) {
  // Claude may return the code with "#state" appended
  let authCode = code;
  let codeState = state;
  if (authCode.includes("#")) {
    const parts = authCode.split("#");
    authCode = parts[0];
    codeState = parts[1] || state;
  }

  const tokenRes = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      code: authCode,
      state: codeState,
      grant_type: "authorization_code",
      client_id: CLAUDE_CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) {
    const t = await tokenRes.text();
    throw new Error(`Claude token exchange: ${tokenRes.status} ${t.slice(0, 300)}`);
  }
  const tokens = (await tokenRes.json()) as {
    access_token: string; refresh_token: string; expires_in: number;
    scope?: string; organization?: { id: string };
  };

  // Fetch org + profile info for account label
  let orgId = tokens.organization?.id;
  let email: string | undefined;
  try {
    const profRes = await fetch("https://api.anthropic.com/api/oauth/profile", {
      headers: { authorization: `Bearer ${tokens.access_token}`, "anthropic-version": "2023-06-01" },
    });
    if (profRes.ok) {
      const prof = (await profRes.json()) as { email?: string; organization?: { id: string } };
      email = prof.email;
      orgId = orgId ?? prof.organization?.id;
    }
  } catch {
    // best-effort
  }

  const account: ClaudeAccount = {
    label: `cc-${(email || orgId || Date.now().toString(36)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 20)}`,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    orgId,
    email,
  };

  // Push to router
  const entry = findEntry("claude-code")!;
  await saveConnection({
    name: entry.id,
    format: entry.format,
    base_url: CLAUDE_BASE_URL,
    models: CLAUDE_MODELS.map((name) => ({ name })),
    accounts: [{ label: account.label, api_key: account.accessToken, priority: 100, weight: 1 }],
    prefix: "cc",
    merge: true,
  });

  // Save to local store for token refresh
  const store = readStore();
  store.claude = [...(store.claude ?? []).filter((a) => a.label !== account.label), account];
  writeStore(store);

  return { label: account.label, email, orgId, models: CLAUDE_MODELS };
}

/** Refresh Claude access token via refresh_token grant. */
async function refreshClaudeToken(acc: ClaudeAccount): Promise<boolean> {
  const res = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: acc.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    }),
  });
  if (!res.ok) {
    console.warn(`[oauth] Claude refresh failed for ${acc.label}: ${res.status} ${await res.text()}`);
    return false;
  }
  const d = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  acc.accessToken = d.access_token;
  acc.refreshToken = d.refresh_token;
  acc.expiresAt = Date.now() + d.expires_in * 1000;

  // Push new access token to the router account
  await saveConnection({
    name: "claude-code",
    format: "anthropic",
    base_url: CLAUDE_BASE_URL,
    models: CLAUDE_MODELS.map((name) => ({ name })),
    accounts: [{ label: acc.label, api_key: acc.accessToken, priority: 100, weight: 1 }],
    prefix: "cc",
    merge: true,
  });
  return true;
}

/** Fetch Claude usage snapshot (5-hour + 7-day windows). */
export async function fetchClaudeUsage(acc: ClaudeAccount) {
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { authorization: `Bearer ${acc.accessToken}`, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) return undefined;
    const d = (await res.json()) as {
      five_hour?: { utilization?: number; resets_at?: string };
      seven_day?: { utilization?: number; resets_at?: string };
    };
    acc.usage = {
      fiveHour: d.five_hour ? { utilization: d.five_hour.utilization, resetsAt: d.five_hour.resets_at } : undefined,
      sevenDay: d.seven_day ? { utilization: d.seven_day.utilization, resetsAt: d.seven_day.resets_at } : undefined,
    };
    return acc.usage;
  } catch {
    return undefined;
  }
}

/** Refresh Claude tokens expiring within 30 minutes (or all on boot). */
export async function refreshClaudeTokens(force = false) {
  const accounts = readStore().claude ?? [];
  if (!accounts.length) return;
  let changed = false;
  for (const acc of accounts) {
    if (!force && acc.expiresAt - Date.now() > 30 * 60_000) continue;
    try {
      const ok = await refreshClaudeToken(acc);
      if (ok) {
        changed = true;
        console.log(`[oauth] Claude token refreshed for ${acc.label}`);
      }
    } catch (e) {
      console.warn(`[oauth] Claude refresh error for ${acc.label}: ${String(e)}`);
    }
  }
  if (changed) writeClaudeAccounts(accounts);
}

/** Disconnect a Claude account: remove from store and delete router connection. */
export async function disconnectClaude(label: string) {
  const store = readStore();
  store.claude = (store.claude ?? []).filter((a) => a.label !== label);
  writeStore(store);
  // If no more Claude accounts remain, remove the whole connection
  if (!store.claude.length) {
    try {
      await routerFetch("/admin/connections/claude-code", { method: "DELETE" });
    } catch {
      // ignore
    }
  } else {
    // Just remove this one account from the router
    try {
      await routerFetch(`/admin/connections/claude-code/accounts/${encodeURIComponent(label)}`, {
        method: "DELETE",
      });
    } catch {
      // ignore
    }
  }
}

export function startRefreshLoop() {
  if ((g as { __oauthTimer2?: NodeJS.Timeout }).__oauthTimer2) return;
  (g as { __oauthTimer2?: NodeJS.Timeout }).__oauthTimer2 = setInterval(() => {
    refreshAll().catch(() => {});
    refreshClaudeTokens().catch(() => {});
  }, 60_000);
  setTimeout(() => {
    refreshAll(true).catch(() => {});
    refreshClaudeTokens(true).catch(() => {});
  }, 3_000);
}
