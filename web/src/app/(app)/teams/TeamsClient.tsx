"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  UserPlus,
  Users,
  UsersRound,
  X,
} from "lucide-react";
import {
  Badge,
  Btn,
  Empty,
  Field,
  PageHeader,
  Panel,
  Select,
  Stat,
  inputCls,
  useFlash,
} from "@/components/ui";

interface Team {
  id: string;
  name: string;
  description?: string;
  createdAt?: string;
}
interface UserRow {
  username: string;
  role: "admin" | "team_lead" | "user";
  displayName: string;
  team: string | null;
  teamName?: string | null;
}

/** Plain fetch helpers (the `api` helper in ui.tsx only talks to /api/proxy). */
async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(path, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b?.error ?? `HTTP ${r.status}`);
  return b as T;
}

const roleLabel: Record<string, string> = {
  admin: "Admin",
  team_lead: "Team Lead",
  user: "User",
};

export default function TeamsClient({
  role,
  username,
  team,
}: {
  role: "admin" | "team_lead";
  username: string;
  team: string | null;
}) {
  const { flash, node } = useFlash();
  const isAdmin = role === "admin";
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ role: string; team: string; displayName: string; password: string }>({
    role: "user",
    team: "",
    displayName: "",
    password: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, u] = await Promise.all([
        call<{ teams: Team[] }>("/api/teams").catch(() => ({ teams: [] })),
        call<{ users: UserRow[] }>("/api/users"),
      ]);
      setTeams(t.teams);
      setUsers(u.users);
    } catch (e) {
      flash(`✗ ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [flash]);

  useEffect(() => {
    load();
  }, [load]);

  const teamName = useMemo(() => {
    const m = new Map(teams.map((t) => [t.id, t.name]));
    return (id: string | null) => (id ? m.get(id) || id : "—");
  }, [teams]);

  // ---------- create team ----------
  const [teamForm, setTeamForm] = useState({ id: "", name: "", description: "" });
  async function createTeam(e: React.FormEvent) {
    e.preventDefault();
    try {
      await call("/api/teams", { body: teamForm });
      setTeamForm({ id: "", name: "", description: "" });
      flash("✓ Đã tạo team");
      load();
    } catch (err) {
      flash(`✗ ${(err as Error).message}`);
    }
  }
  async function removeTeam(id: string) {
    if (!confirm(`Xoá team '${id}'? Thành viên sẽ được bỏ gán team.`)) return;
    try {
      await call(`/api/teams?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      flash("✓ Đã xoá team");
      load();
    } catch (err) {
      flash(`✗ ${(err as Error).message}`);
    }
  }

  // ---------- create user ----------
  const [userForm, setUserForm] = useState({ username: "", password: "", displayName: "", role: "user", team: team || "" });
  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    try {
      await call("/api/users", {
        body: {
          username: userForm.username,
          password: userForm.password,
          displayName: userForm.displayName || undefined,
          role: isAdmin ? userForm.role : "user",
          team: isAdmin ? userForm.team || null : team,
        },
      });
      setUserForm({ username: "", password: "", displayName: "", role: "user", team: team || "" });
      flash("✓ Đã tạo user");
      load();
    } catch (err) {
      flash(`✗ ${(err as Error).message}`);
    }
  }

  async function saveUser(u: UserRow) {
    try {
      const patch: Record<string, unknown> = { username: u.username };
      if (isAdmin) {
        patch.role = editForm.role;
        patch.team = editForm.team || null;
      }
      if (editForm.displayName) patch.displayName = editForm.displayName;
      if (editForm.password) patch.password = editForm.password;
      await call("/api/users", { method: "PATCH", body: patch });
      setEditingUser(null);
      setEditForm({ role: "user", team: "", displayName: "", password: "" });
      flash("✓ Đã cập nhật user");
      load();
    } catch (err) {
      flash(`✗ ${(err as Error).message}`);
    }
  }

  async function removeUser(u: UserRow) {
    if (!confirm(`Xoá user '${u.username}'?`)) return;
    try {
      await call(`/api/users?username=${encodeURIComponent(u.username)}`, { method: "DELETE" });
      flash("✓ Đã xoá user");
      load();
    } catch (err) {
      flash(`✗ ${(err as Error).message}`);
    }
  }

  const canManage = (u: UserRow) => {
    if (isAdmin) return u.username !== username;
    // team lead: only plain members of their own team
    return u.role === "user" && u.team === team && u.username !== username;
  };

  return (
    <div className="space-y-6">
      {node}
      <PageHeader
        icon={Users}
        title={isAdmin ? "Teams & Users" : `Team ${teamName(team)}`}
        desc={
          isAdmin
            ? "Tạo team, gán user vào team và cấp vai trò. Mỗi team tự cấu hình provider riêng; user tạo API key trong phạm vi team."
            : "Quản lý thành viên trong team của bạn. Thành viên tự tạo API key trong Endpoint & Key."
        }
        actions={
          <Btn onClick={load}>
            <RefreshCw size={14} /> Tải lại
          </Btn>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        {isAdmin && <Stat label="Teams" value={String(teams.length)} icon={UsersRound} />}
        <Stat label="Users" value={String(users.length)} icon={Users} />
        <Stat label="Vai trò của bạn" value={roleLabel[role]} icon={KeyRound} />
      </div>

      <div className={`grid gap-4 ${isAdmin ? "lg:grid-cols-3" : ""}`}>
        {isAdmin && (
          <div className="space-y-4">
            <Panel title="Teams" icon={UsersRound}>
              {teams.length ? (
                <ul className="space-y-1.5">
                  {teams.map((t) => (
                    <li
                      key={t.id}
                      className="group flex items-center justify-between rounded-xl border border-zinc-800/60 bg-zinc-950/40 px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-zinc-100">{t.name}</span>
                          <code className="rounded bg-zinc-800/70 px-1.5 py-px font-mono text-[10px] text-zinc-400">{t.id}</code>
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-zinc-500">
                          {t.description || "—"} · {users.filter((u) => u.team === t.id).length} thành viên
                        </div>
                      </div>
                      <button
                        onClick={() => removeTeam(t.id)}
                        title="Xoá team"
                        className="rounded-lg p-1.5 text-zinc-500 opacity-60 transition hover:bg-rose-950/40 hover:text-rose-300 group-hover:opacity-100"
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty icon={UsersRound}>Chưa có team nào.</Empty>
              )}
            </Panel>

            <Panel title="Tạo team" icon={Plus}>
              <form onSubmit={createTeam} className="space-y-3">
                <Field label="ID" hint="Chữ thường/số/gạch, vd: team-a">
                  <input
                    value={teamForm.id}
                    onChange={(e) => setTeamForm({ ...teamForm, id: e.target.value })}
                    placeholder="team-a"
                    className={`${inputCls} font-mono`}
                    required
                  />
                </Field>
                <Field label="Tên hiển thị">
                  <input
                    value={teamForm.name}
                    onChange={(e) => setTeamForm({ ...teamForm, name: e.target.value })}
                    placeholder="Team A"
                    className={inputCls}
                    required
                  />
                </Field>
                <Field label="Mô tả">
                  <input
                    value={teamForm.description}
                    onChange={(e) => setTeamForm({ ...teamForm, description: e.target.value })}
                    placeholder="(tuỳ chọn)"
                    className={inputCls}
                  />
                </Field>
                <Btn variant="primary" type="submit" className="w-full">
                  <Plus size={14} /> Tạo team
                </Btn>
              </form>
            </Panel>
          </div>
        )}

        <div className={`space-y-4 ${isAdmin ? "lg:col-span-2" : ""}`}>
          <Panel title={<>Thành viên ({users.length})</>} icon={Users}>
            {users.length ? (
              <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
                <table className="w-full text-left text-xs">
                  <thead className="bg-zinc-900/90 text-[10px] uppercase tracking-wider text-zinc-500">
                    <tr className="border-b border-zinc-800">
                      <th className="px-3 py-2.5 font-medium">User</th>
                      <th className="px-3 py-2.5 font-medium">Vai trò</th>
                      {isAdmin && <th className="px-3 py-2.5 font-medium">Team</th>}
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.username} className="border-b border-zinc-800/40 last:border-0 hover:bg-zinc-800/20">
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-zinc-200">{u.displayName}</div>
                          <div className="font-mono text-[10.5px] text-zinc-500">{u.username}</div>
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge tone={u.role === "admin" ? "rose" : u.role === "team_lead" ? "amber" : "cyan"}>
                            {roleLabel[u.role]}
                          </Badge>
                        </td>
                        {isAdmin && (
                          <td className="px-3 py-2.5 text-zinc-400">{u.teamName || teamName(u.team)}</td>
                        )}
                        <td className="px-3 py-2.5 text-right">
                          {canManage(u) && (
                            <span className="flex justify-end gap-0.5 opacity-70 transition-opacity hover:opacity-100">
                              {isAdmin && (
                                <button
                                  onClick={() => {
                                    setEditingUser(editingUser === u.username ? null : u.username);
                                    setEditForm({
                                      role: u.role,
                                      team: u.team || "",
                                      displayName: u.displayName,
                                      password: "",
                                    });
                                  }}
                                  title="Sửa"
                                  className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100"
                                >
                                  <Pencil size={13} />
                                </button>
                              )}
                              {!isAdmin && (
                                <button
                                  onClick={() => {
                                    setEditingUser(editingUser === u.username ? null : u.username);
                                    setEditForm({
                                      role: u.role,
                                      team: u.team || "",
                                      displayName: u.displayName,
                                      password: "",
                                    });
                                  }}
                                  title="Đặt lại mật khẩu"
                                  className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100"
                                >
                                  <KeyRound size={13} />
                                </button>
                              )}
                              <button
                                onClick={() => removeUser(u)}
                                title="Xoá"
                                className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-rose-950/40 hover:text-rose-300"
                              >
                                <Trash2 size={13} />
                              </button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon={Users}>Chưa có thành viên.</Empty>
            )}
          </Panel>

          {editingUser && (
            <Panel title={`Sửa ${editingUser}`} icon={Pencil}>
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  {isAdmin && (
                    <Field label="Vai trò">
                      <Select value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}>
                        <option value="user">User</option>
                        <option value="team_lead">Team Lead</option>
                        <option value="admin">Admin</option>
                      </Select>
                    </Field>
                  )}
                  {isAdmin && (
                    <Field label="Team">
                      <Select value={editForm.team} onChange={(e) => setEditForm({ ...editForm, team: e.target.value })}>
                        <option value="">— Không gán —</option>
                        {teams.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name} ({t.id})
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  <Field label="Tên hiển thị">
                    <input
                      value={editForm.displayName}
                      onChange={(e) => setEditForm({ ...editForm, displayName: e.target.value })}
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Mật khẩu mới" hint="Bỏ trống = giữ nguyên">
                    <input
                      type="password"
                      value={editForm.password}
                      onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                      placeholder="••••••••"
                      className={inputCls}
                    />
                  </Field>
                </div>
                <div className="flex gap-2">
                  <Btn variant="primary" onClick={() => {
                    const u = users.find((x) => x.username === editingUser);
                    if (u) saveUser(u);
                  }}>
                    <Check size={14} /> Lưu
                  </Btn>
                  <Btn onClick={() => setEditingUser(null)}>
                    <X size={13} /> Huỷ
                  </Btn>
                </div>
              </div>
            </Panel>
          )}

          <Panel title={<>Thêm thành viên</>} icon={UserPlus}>
            <form onSubmit={createUser} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Username">
                  <input
                    value={userForm.username}
                    onChange={(e) => setUserForm({ ...userForm, username: e.target.value })}
                    placeholder="alice"
                    className={inputCls}
                    required
                  />
                </Field>
                <Field label="Mật khẩu" hint="≥ 8 ký tự">
                  <input
                    type="password"
                    value={userForm.password}
                    onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                    placeholder="••••••••"
                    className={inputCls}
                    required
                  />
                </Field>
                <Field label="Tên hiển thị">
                  <input
                    value={userForm.displayName}
                    onChange={(e) => setUserForm({ ...userForm, displayName: e.target.value })}
                    placeholder="(tuỳ chọn)"
                    className={inputCls}
                  />
                </Field>
                {isAdmin ? (
                  <Field label="Vai trò">
                    <Select value={userForm.role} onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}>
                      <option value="user">User</option>
                      <option value="team_lead">Team Lead</option>
                      <option value="admin">Admin</option>
                    </Select>
                  </Field>
                ) : (
                  <Field label="Team">
                    <input value={teamName(team)} readOnly className={`${inputCls} opacity-70`} />
                  </Field>
                )}
                {isAdmin && userForm.role !== "admin" && (
                  <Field label="Team" hint="Bắt buộc với user/team lead">
                    <Select value={userForm.team} onChange={(e) => setUserForm({ ...userForm, team: e.target.value })}>
                      <option value="">— Chọn team —</option>
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.id})
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
              </div>
              <Btn variant="primary" type="submit" disabled={loading}>
                <UserPlus size={14} /> Thêm user
              </Btn>
            </form>
          </Panel>
        </div>
      </div>
    </div>
  );
}