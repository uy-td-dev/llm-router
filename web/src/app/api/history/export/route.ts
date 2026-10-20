import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { routerFetch } from "@/lib/router";

const GROUPS = new Set(["raw", "day", "key", "provider", "model"]);

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * GET /api/history/export?group=raw|day|key|provider|model&minutes=N[&api_key=L]
 * Streams the usage history as a CSV download. Scoped like the History API:
 * admin = everything, team lead = their team, member = their own rows
 * (the admin key stays server-side).
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const group = GROUPS.has(sp.get("group") ?? "") ? sp.get("group")! : "raw";
  const minutes = Math.max(1, Number(sp.get("minutes")) || 1440);
  // A member may only export their own rows, so api_key overrides are ignored
  // for them (the owner filter already narrows it).
  const apiKey = session.role === "user" ? undefined : sp.get("api_key") || undefined;

  const qs = new URLSearchParams({ group, minutes: String(minutes) });
  if (apiKey) qs.set("api_key", apiKey);
  if (session.role === "team_lead") qs.set("team", session.team || "");
  else if (session.role === "user") qs.set("owner", session.username);

  const res = await routerFetch(`/admin/history?${qs.toString()}`);
  if (!res.ok) {
    return NextResponse.json(
      { error: `History API lỗi (${res.status}) — history cần database.mode sqlite/postgres` },
      { status: 502 },
    );
  }
  const data = (await res.json()) as {
    rows?: Record<string, unknown>[];
    note?: string;
  };
  const rows = data.rows ?? [];
  if (rows.length === 0) {
    return NextResponse.json(
      { error: data.note ?? "Không có bản ghi usage trong khoảng thời gian này" },
      { status: 404 },
    );
  }

  // Column order = first row's key order (stable), header Vietnamese-neutral
  const cols = Object.keys(rows[0]);
  const lines = [cols.map(csvEscape).join(",")].concat(
    rows.map((r) => cols.map((c) => csvEscape(r[c])).join(",")),
  );
  const csv = `\uFEFF${lines.join("\r\n")}`; // BOM so Excel opens UTF-8 properly

  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="llm-router-history-${group}-${minutes}m.csv"`,
      "cache-control": "no-store",
    },
  });
}
