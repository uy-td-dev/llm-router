import { NextRequest, NextResponse } from "next/server";
import {
  createTeam,
  deleteTeam,
  getSession,
  listTeams,
  updateTeam,
} from "@/lib/auth";

/**
 * /api/teams — team registry.
 *   - admin: CRUD all teams.
 *   - team_lead: read own team only (no mutation).
 *   - user: 403.
 */
export async function GET() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (s.role === "user") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const teams = listTeams();
  if (s.role === "team_lead") {
    const mine = teams.filter((t) => t.id === s.team);
    return NextResponse.json({ teams: mine });
  }
  return NextResponse.json({ teams });
}

export async function POST(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (s.role !== "admin") return NextResponse.json({ error: "forbidden: chỉ admin" }, { status: 403 });
  const body = await req.json().catch(() => null);
  if (!body?.id || !body?.name) {
    return NextResponse.json({ error: "Thiếu id hoặc name" }, { status: 400 });
  }
  const res = createTeam(String(body.id), String(body.name), body.description ? String(body.description) : undefined);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ team: res.team }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (s.role !== "admin") return NextResponse.json({ error: "forbidden: chỉ admin" }, { status: 403 });
  const body = await req.json().catch(() => null);
  if (!body?.id) return NextResponse.json({ error: "Thiếu id" }, { status: 400 });
  const res = updateTeam(String(body.id), {
    name: body.name !== undefined ? String(body.name) : undefined,
    description: body.description !== undefined ? String(body.description) : undefined,
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ team: res.team });
}

export async function DELETE(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (s.role !== "admin") return NextResponse.json({ error: "forbidden: chỉ admin" }, { status: 403 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Thiếu id" }, { status: 400 });
  const res = deleteTeam(id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}