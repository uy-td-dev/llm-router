# LLM Router — Web Dashboard (Next.js + TypeScript + Tailwind)

Web UI quản trị llm-router (Rust). Browser **không bao giờ** nhìn thấy
ADMIN_API_KEY — mọi lệnh admin đi qua BFF (`/api/proxy/*`) của Next server.

## Cấu trúc bảo mật

```
Browser ──cookie HTTPS──► Next.js (BFF)
                            ├─ JWT httpOnly session (view/app auth)
                            ├─ role check (admin | team_lead | user)
                            └─ server env ROUTER_URL + ADMIN_API_KEY ──► llm-router :8080
```

- Xác thực: username/password đăng nhập `/login`, session JWT httpOnly 8h
  (jose HS256, `AUTH_SECRET` env). Users đặt tại `web/data/users.json`
  (sha256 password hash); **tự đăng ký** `/register` (role `user`, username
  3–32 ký tự, password ≥ 8 — insert trực tiếp users.json).
- Teams đặt tại `web/data/teams.json` (admin quản lý). Mỗi user thuộc đúng 1 team
  (admin có thể không có team). Team id phải khớp `^[a-z][a-z0-9_-]{1,31}$`.
- Phân quyền (RBAC):
  - `admin`: mọi route admin, CRUD virtual keys, team/user management.
  - `team_lead`: quản lý team của mình — thêm member, provider, model allow-list,
    xem usage/keys theo team. Trang `/teams` + `/providers` + `/keys` + `/usage`.
  - `user`: chỉ `/endpoint` (key + usage của chính mình), không thấy provider/settings.
- BFF chỉ forward các path whitelist — các endpoint admin không listed sẽ 403.
- Không route nào của llm-router được expose trực tiếp ra Internet; chỉ port
  của Next UI cần công khai, `llm-router` giữ ở mạng nội bộ.
- Rust data-plane: `KeyConfig.team` + `Connection.team`; một key của team chỉ
  route qua provider của team đó (fail-closed: team không có provider → key không
  reach được provider nào). Usage được scope theo `owner` (user) hoặc `team`
  (team lead) — hub report được tính lại từ request ring khi scope.

## Chạy

```bash
# 1. Rust llm-router (port 8080)
cargo run          # thư mục gốc D:\code\llm-router

# 2. Web (port 3000)
cd web
# Cấu hình .env.local trước: AUTH_SECRET, ADMIN_API_KEY, ROUTER_URL
npm install
npm run build && npm start
```

Đăng nhập seed: `admin / admin123` (đổi ngay trong production — chỉnh
`data/users.json` sau khi chạy lại script hash).

## Trang

| Route | Role | Nội dung |
|---|---|---|
| `/login` | mở | Login JWT session |
| `/register` | mở | Tự động tạo tài khoản (role `user`, chưa có team) + auto-login |
| `/dash` | admin | Cards requests/tokens/cost + biểu đồ (CSS bars) chi tiêu/requests theo provider·model + theo key; lịch sử (`group day/key/provider/model/raw`, cửa sổ 1h–30d) + **Xuất CSV** |
| `/keys` | admin | Danh sách virtual key, thêm/xóa runtime (glob model/provider, RPM, budget) |
| `/providers` | admin, lead | Models list + status account pool; lead chỉ thấy connection của team mình (thêm account, test; không sửa prefix/base_url) |
| `/teams` | admin, lead | Admin: tạo/xóa team, CRUD user, gán role/team, đổi mật khẩu. Lead: quản lý member trong team mình |
| `/endpoint` | mọi role | Tạo/quản lý API key của mình (user chỉ thấy key của user; lead thấy cả key team), copy base URL + key; `/v1/models` scope theo key |
| `/usage` | mọi role | Usage tự scope: user = của mình (`owner`), lead = team (`team`), admin = tất cả |
| `/config` | admin | Editor `config/default.yaml` |
| `/chat` | admin | Chat playground (dùng VIRTUAL_KEY chung — vì thế giới hạn admin) |
| `/mcp` | mọi role | Hướng dẫn kết nối MCP client |

Lưu ý team/provider:
- Tên connection là duy nhất toàn instance. Team B không thể đặt trùng tên
  connection của team A (BFF chặn "takeover"). Hai team muốn cùng 1 loại
  upstream (vd cùng "openai") thì phải đặt tên khác nhau.
- Xóa team: member bị bỏ gán, `team_lead` bị hạ xuống `user`.
- User chưa có team không tạo được key (BFF từ chối).

## Roadmap (web)

1. **OAuth provider accounts** — nút "Connect" Claude/Gemini/ChatGPT:
   OAuth flow, save refresh-token vào Vault account pool của llm-router
   (mở rộng admin API `/admin/providers/*/account`).
2. **Provider config editor** — UI sửa YAML cần admin API `GET/PUT /admin/config`
   phía Rust (hiện config là file, edit qua web yêu cầu persist + reload).
3. **Confirm user registration** thay vì users.json handcrafted.
4. **Chart lib** (recharts) + export CSV usage history.
