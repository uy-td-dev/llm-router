import { NextRequest, NextResponse } from "next/server";
import { createUser, deleteUser, getSession, listTeams, listUsers, updateUser } from "@/lib/auth";

/**
 * /api/users — user management, scoped by role.
 *   - admin: all users, full CRUD (role/team/password/displayName).
 *   - team_lead: users of their own team; may create/update/delete members
 *     of that team (never their own role/team, never admins).
 *   - user: read own record only (profile), may change own password/name.
 */
export async function GET() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const teams = listTeams();
  const withTeamName = (u: ReturnType<typeof listUsers>[number]) => ({
    username: u.username,
    role: u.role,
    displayName: u.displayName || u.username,
    team: u.team ?? null,
    teamName: u.team ? teams.find((t) => t.id === u.team)?.name || u.team : null,
  });

  if (s.role === "admin") {
    return NextResponse.json({ users: listUsers().map(withTeamName) });
  }
  if (s.role === "team_lead") {
    return NextResponse.json({ users: listUsers().filter((u) => u.team === s.team).map(withTeamName) });
  }
  const me = listUsers().find((u) => u.username === s.username);
  return NextResponse.json({ users: me ? [withTeamName(me)] : [] });
}

export async function POST(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body?.username || !body?.password) {
    return NextResponse.json({ error: "Thiếu username/password" }, { status: 400 });
  }

  let role: "admin" | "team_lead" | "user" = "user";
  let team: string | null = null;

  if (s.role === "admin") {
    role = body.role === "admin" || body.role === "team_lead" ? body.role : "user";
    team = body.team ?? null;
    if (role !== "admin" && !team) {
      return NextResponse.json({ error: "User/team lead phải thuộc một team" }, { status: 400 });
    }
    if (role === "team_lead" && listTeams().every((t) => t.id !== team)) {
      return NextResponse.json({ error: "Team không tồn tại" }, { status: 400 });
    }
  } else if (s.role === "team_lead") {
    if (!s.team) return NextResponse.json({ error: "Bạn chưa có team" }, { status: 403 });
    // Leads can only create plain members inside their own team.
    if (body.role && body.role !== "user") {
      return NextResponse.json({ error: "Team lead chỉ tạo được user thường" }, { status: 403 });
    }
    if (body.team && body.team !== s.team) {
      return NextResponse.json({ error: "Không được tạo user vào team khác" }, { status: 403 });
    }
    team = s.team;
    role = "user";
  } else {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const res = createUser(
    String(body.username),
    String(body.password),
    body.displayName ? String(body.displayName) : undefined,
    role,
    team
  );
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ user: res.user }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const target = String(body?.username || "").toLowerCase();
  if (!target) return NextResponse.json({ error: "Thiếu username" }, { status: 400 });

  const users = listUsers();
  const targetRec = users.find((u) => u.username === target);
  if (!targetRec) return NextResponse.json({ error: "Không tìm thấy user" }, { status: 404 });

  const patch: Parameters<typeof updateUser>[1] = {};

  if (s.role === "admin") {
    if (body.role !== undefined) patch.role = body.role;
    if (body.team !== undefined) patch.team = body.team ?? null;
    if (body.password !== undefined) patch.password = String(body.password);
    if (body.displayName !== undefined) patch.displayName = String(body.displayName);
    // Demoting/downgrading the last admin would lock everyone out.
    if (targetRec.role === "admin" && target === s.username && patch.role && patch.role !== "admin") {
      const admins = users.filter((u) => u.role === "admin");
      if (admins.length <= 1) {
        return NextResponse.json({ error: "Không thể hạ cấp admin cuối cùng" }, { status: 400 });
      }
    }
  } else if (s.role === "team_lead") {
    if (!s.team || targetRec.team !== s.team) {
      return NextResponse.json({ error: "Không thuộc team của bạn" }, { status: 403 });
    }
    if (body.role !== undefined || body.team !== undefined) {
      return NextResponse.json({ error: "Team lead chỉ đổi được mật khẩu/tên hiển thị" }, { status: 403 });
    }
    if (target === s.username && body.role !== undefined) {
      return NextResponse.json({ error: "Không thể tự đổi vai trò" }, { status: 403 });
    }
    if (body.password !== undefined) patch.password = String(body.password);
    if (body.displayName !== undefined) patch.displayName = String(body.displayName);
  } else {
    // user: self-service only
    if (target !== s.username) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (body.role !== undefined || body.team !== undefined) {
      return NextResponse.json({ error: "Không thể tự đổi vai trò/team" }, { status: 403 });
    }
    if (body.password !== undefined) patch.password = String(body.password);
    if (body.displayName !== undefined) patch.displayName = String(body.displayName);
  }

  const res = updateUser(target, patch);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ user: res.user });
}

export async function DELETE(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const username = req.nextUrl.searchParams.get("username") || "";
  if (!username) return NextResponse.json({ error: "Thiếu username" }, { status: 400 });

  const users = listUsers();
  const targetRec = users.find((u) => u.username === username.toLowerCase());

  if (s.role === "admin") {
    if (username.toLowerCase() === s.username) {
      return NextResponse.json({ error: "Không thể tự xóa tài khoản" }, { status: 400 });
    }
  } else if (s.role === "team_lead") {
    if (!targetRec || !s.team || targetRec.team !== s.team) {
      return NextResponse.json({ error: "Không thuộc team của bạn" }, { status: 403 });
    }
    if (targetRec.role !== "user") {
      return NextResponse.json({ error: "Team lead chỉ xóa được user thường" }, { status: 403 });
    }
  } else {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const res = deleteUser(username);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}