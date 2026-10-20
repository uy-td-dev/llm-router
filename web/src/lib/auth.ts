import { cookies } from "next/headers";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { verifySessionToken, createSessionToken, SESSION_COOKIE, type SessionUser, type Role } from "./session";

export { createSessionToken, verifySessionToken, SESSION_COOKIE };
export type { SessionUser, Role };

export interface UserRecord {
  username: string;
  passwordHash: string;
  role: Role;
  displayName?: string;
  /** Team id this user belongs to (null/undefined = unassigned, admin default). */
  team?: string | null;
}

export interface TeamRecord {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
}

const USERS_FILE = path.join(process.cwd(), "data", "users.json");
const TEAMS_FILE = path.join(process.cwd(), "data", "teams.json");

function sha256(v: string): string {
  return crypto.createHash("sha256").update(v).digest("hex");
}

/** atomic-ish: write tmp then rename so a crash never truncates the store */
function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function loadJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function listUsers(): UserRecord[] {
  return loadJson<UserRecord[]>(USERS_FILE, []);
}

function saveUsers(users: UserRecord[]): void {
  writeJsonAtomic(USERS_FILE, users);
}

export function listTeams(): TeamRecord[] {
  return loadJson<TeamRecord[]>(TEAMS_FILE, []);
}

function saveTeams(teams: TeamRecord[]): void {
  writeJsonAtomic(TEAMS_FILE, teams);
}

// ============================ teams ============================

export const TEAM_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;

export function createTeam(id: string, name: string, description?: string): { ok: true; team: TeamRecord } | { ok: false; error: string } {
  const tid = id.trim().toLowerCase();
  if (!TEAM_ID_RE.test(tid)) {
    return { ok: false, error: "Team id phải 2–32 ký tự, chữ thường/số/dấu gạch, bắt đầu bằng chữ" };
  }
  if (!name.trim()) return { ok: false, error: "Tên team là bắt buộc" };
  const teams = listTeams();
  if (teams.some((t) => t.id === tid)) return { ok: false, error: `Team '${tid}' đã tồn tại` };
  const team: TeamRecord = { id: tid, name: name.trim(), description: description?.trim() || undefined, createdAt: new Date().toISOString() };
  teams.push(team);
  saveTeams(teams);
  return { ok: true, team };
}

export function deleteTeam(id: string): { ok: true } | { ok: false; error: string } {
  const teams = listTeams();
  const next = teams.filter((t) => t.id !== id);
  if (next.length === teams.length) return { ok: false, error: "Không tìm thấy team" };
  saveTeams(next);
  // Unassign members so no user keeps pointing at a deleted team.
  const users = listUsers();
  let changed = false;
  for (const u of users) {
    if (u.team === id) {
      u.team = null;
      if (u.role === "team_lead") u.role = "user";
      changed = true;
    }
  }
  if (changed) saveUsers(users);
  return { ok: true };
}

export function updateTeam(id: string, patch: { name?: string; description?: string }): { ok: true; team: TeamRecord } | { ok: false; error: string } {
  const teams = listTeams();
  const team = teams.find((t) => t.id === id);
  if (!team) return { ok: false, error: "Không tìm thấy team" };
  if (patch.name !== undefined) {
    if (!patch.name.trim()) return { ok: false, error: "Tên team là bắt buộc" };
    team.name = patch.name.trim();
  }
  if (patch.description !== undefined) team.description = patch.description.trim() || undefined;
  saveTeams(teams);
  return { ok: true, team };
}

// ============================ users ============================

const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{2,31}$/;

function normalizeUser(u: UserRecord): SessionUser {
  return {
    username: u.username,
    role: u.role,
    displayName: u.displayName || u.username,
    team: u.team ?? null,
  };
}

export function getUser(username: string): UserRecord | null {
  const un = username.trim().toLowerCase();
  return listUsers().find((u) => u.username === un) ?? null;
}

export function verifyCredentials(username: string, password: string): SessionUser | null {
  const u = getUser(username);
  if (!u) return null;
  if (u.passwordHash !== sha256(password)) return null;
  return normalizeUser(u);
}

export function createUser(
  username: string,
  password: string,
  displayName?: string,
  role: Role = "user",
  team: string | null = null
): { ok: true; user: SessionUser } | { ok: false; error: string } {
  const un = username.trim().toLowerCase();
  if (!USERNAME_RE.test(un)) return { ok: false, error: "Username 3–32 ký tự, bắt đầu bằng chữ" };
  if (password.length < 8) return { ok: false, error: "Password phải có ít nhất 8 ký tự" };
  if (team !== null && !listTeams().some((t) => t.id === team)) {
    return { ok: false, error: `Team '${team}' không tồn tại` };
  }
  const users = listUsers();
  if (users.some((u) => u.username === un)) return { ok: false, error: `Username '${un}' đã tồn tại` };
  const rec: UserRecord = {
    username: un,
    passwordHash: sha256(password),
    role,
    displayName: displayName?.trim() || un,
    team,
  };
  users.push(rec);
  saveUsers(users);
  return { ok: true, user: normalizeUser(rec) };
}

export interface UserPatch {
  role?: Role;
  team?: string | null;
  password?: string;
  displayName?: string;
}

export function updateUser(username: string, patch: UserPatch): { ok: true; user: SessionUser } | { ok: false; error: string } {
  const users = listUsers();
  const u = users.find((x) => x.username === username.trim().toLowerCase());
  if (!u) return { ok: false, error: "Không tìm thấy user" };
  if (patch.role !== undefined) {
    if (!["admin", "team_lead", "user"].includes(patch.role)) return { ok: false, error: "Role không hợp lệ" };
    u.role = patch.role;
  }
  if (patch.team !== undefined) {
    if (patch.team !== null && !listTeams().some((t) => t.id === patch.team)) {
      return { ok: false, error: `Team '${patch.team}' không tồn tại` };
    }
    // team_lead must lead some team
    if (u.role === "team_lead" && !patch.team) {
      return { ok: false, error: "Team lead phải thuộc một team" };
    }
    u.team = patch.team;
  }
  if (patch.password !== undefined) {
    if (patch.password.length < 8) return { ok: false, error: "Password phải có ít nhất 8 ký tự" };
    u.passwordHash = sha256(patch.password);
  }
  if (patch.displayName !== undefined) u.displayName = patch.displayName.trim() || u.username;
  saveUsers(users);
  return { ok: true, user: normalizeUser(u) };
}

export function deleteUser(username: string): { ok: true } | { ok: false; error: string } {
  const un = username.trim().toLowerCase();
  const users = listUsers();
  const target = users.find((u) => u.username === un);
  if (!target) return { ok: false, error: "Không tìm thấy user" };
  if (target.role === "admin" && users.filter((u) => u.role === "admin").length <= 1) {
    return { ok: false, error: "Không thể xóa admin cuối cùng" };
  }
  saveUsers(users.filter((u) => u.username !== un));
  return { ok: true };
}

// ============================ sessions ============================

export async function getSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}
