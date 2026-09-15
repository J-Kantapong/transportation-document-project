# Shared transport registration project

This is the live source workspace shared with the user's Codex task. Work in this directory; do not create a second copy or isolated worktree unless the user asks. UI and backend source changes here are visible to both tools after re-reading files. Chat history is not synchronized.

## Collaboration
- User prefers Thai and incremental instructions, one step at a time.
- Codex handles UI design; Claude Code handles database/backend work as requested.
- Inspect current git status and relevant files before editing. Preserve other agents' uncommitted changes. Avoid editing the same file concurrently.
- Keep the current Thai UI, navigation, and seven customer fields unless requested otherwise.
- After backend changes, update docs/SHARED-PROJECT.md with changed endpoints/schema, checks performed, and any UI integration needed.
- Shared files do not imply automatic deployment. Sites publication is managed separately from Codex. Do not change .openai/hosting.json, publish, or modify production data merely to establish this handoff.
- Read docs/SHARED-PROJECT.md for the current implementation.

## Main files
- dist/index.html: actual authored UI source, not disposable build output.
- server/worker.js: Cloudflare Worker source, GET/POST /api/customers.
- db/schema.ts: Drizzle SQLite schema.
- drizzle/: production migrations; already-applied migrations are immutable.
- build.mjs: embeds UI in dist/server/index.js and stages hosting metadata/migrations.
- package.json and pnpm-lock.yaml: install with pnpm install --frozen-lockfile; build with pnpm run build.

New vehicle registration has four subtask headings (see docs/SHARED-PROJECT.md). The first subtask now has Single/Batch vehicle entry; read docs/VEHICLE-ENTRY.md. Other subtask pages and registration categories intentionally have no fields yet. Wait for user instructions before adding workflows.
