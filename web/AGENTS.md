<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## UI conventions

Design system lives in `src/components/ui.tsx` + `src/app/globals.css`.

- Never inline one-off button/panel/card styles. Use `Btn`, `Panel`, `Stat`, `Badge`, `Field`, `Empty`, `CopyBtn`, `Code`, `Select`, `Segmented`, `Meter`, `Toggle`.
- `Btn` variants: `primary` (one per view, for the main CTA) · `ghost` (default) · `subtle` (toolbar) · `danger`. Sizes: `sm` / `md` (default) / `lg`.
- `inputCls` is the shared input class; use it for every text/select/textarea field.
- Theming: zinc base + emerald primary accent. Tones are `emerald | cyan | violet | amber | rose` for `Stat`/`Meter`.
- Utility classes available in globals.css: `noise-bg`, `glass`, `glass-card`, `animate-fade-in`, `animate-slide-in`, `animate-pulse-glow`, `stagger-children`, `text-gradient-emerald`.
- Layout: `(app)/layout.tsx` owns ambient background + sidebar offset (`lg:ml-64`). Don't add page-level padding there.
- Sidebar nav groups and the admin-only gating live in `src/components/Sidebar.tsx` — add new pages there, not in a page file.
- Verify changes with `node ./node_modules/next/dist/bin/next build` from `web/` (the project pins Next 16 + Turbopack).
