# Deployment

Production topology: **Neon** (Postgres) → **Render** (NestJS backend) → **Vercel** (Next.js frontend).

The two apps reference each other by URL, so deploy in this order and expect one
round of "come back and set this env var" after the backend has a real URL.

## 1. Neon (database)

Already provisioned. Current production database: Neon project
`transportation-document-project` (`small-river-26857171`, `aws-ap-southeast-1`).

- Connection strings live in `backend/.env` locally (gitignored — never commit them). Two are needed:
  - `DATABASE_URL` — the **pooled** connection string (host ends in `-pooler`). Used by the running
    app (`backend/src/prisma/prisma.service.ts`), which is a long-running server, not a serverless
    function — the pooler just adds headroom against exhausting Neon's connection limit.
  - `DIRECT_URL` — the **direct** (non-pooled) connection string. Used only by Prisma CLI commands
    (`prisma migrate deploy`, etc. — see `backend/prisma7.config.ts`), because Neon's PgBouncer
    pooler doesn't support the session-level features schema migrations rely on.
  - Get both with `neon connection-string --project-id small-river-26857171` (direct) and
    `--pooled` (pooled), or copy them from the Neon dashboard.
- Migrations are applied with `npx prisma migrate deploy` (Render runs this automatically, see below).
- If you want separate dev/staging/prod databases, use a Neon branch per environment instead of a
  new project — same schema, isolated data. See the `neon-postgres` skill / Neon docs for branching.

## 2. Render (backend)

Repo root has `render.yaml` — a Render Blueprint. In the Render dashboard:

1. **New +** → **Blueprint** → connect this GitHub repo → Render reads `render.yaml` and
   proposes a web service named `transportation-document-backend` rooted at `backend/`.
2. Before the first deploy, set the three env vars the blueprint leaves blank (`sync: false`
   means "you fill this in", not "optional"):
   - `DATABASE_URL` — the Neon **pooled** connection string.
   - `DIRECT_URL` — the Neon **direct** connection string.
   - `FRONTEND_ORIGIN` — leave as a placeholder (e.g. `https://placeholder.vercel.app`) for now;
     you'll come back and set it to the real Vercel URL after step 3.
3. Deploy. The blueprint's `buildCommand` runs `prisma generate`, then `prisma migrate deploy`
   against `DIRECT_URL`, then `nest build` — all in one step. (Render's separate
   `preDeployCommand` hook needs a paid plan, so on the free tier migrations run as part of the
   build instead; if you're on a paid plan you can split `prisma migrate deploy` out into
   `preDeployCommand` so it only runs once per deploy instead of once per build.)
4. Note the resulting service URL, e.g. `https://transportation-document-backend.onrender.com`.

If you set this service up by hand instead of via the Blueprint, double check in
**Settings → Build & Deploy**: Root Directory `backend`, Build Command as above, and
**Start Command** `npm run start:prod` (not `npm run start` / `npm start`, which runs
unbuilt TypeScript directly via `nest start` and will fail with "property does not exist on
type PrismaService" errors since the Prisma client and compiled output were never produced).

Free-tier Render web services spin down after ~15 minutes idle; the first request after that
takes a few seconds (cold start). Fine for a prototype, worth upgrading the plan before real use.

## 3. Vercel (frontend)

1. **Add New** → **Project** → import this GitHub repo.
2. **Root Directory**: set to `frontend` (Vercel auto-detects Next.js once the root is set —
   no `vercel.json` needed).
3. Add an environment variable:
   - `NEXT_PUBLIC_API_BASE_URL` = the Render URL from step 2 (e.g.
     `https://transportation-document-backend.onrender.com`).
4. Deploy. Note the resulting URL, e.g. `https://transportation-document-project.vercel.app`.

## 4. Close the loop: lock down CORS

Go back to the Render service's env vars and set `FRONTEND_ORIGIN` to the real Vercel URL from
step 3, then trigger a redeploy (or it picks it up on the next auto-deploy). This restricts the
backend's CORS policy (`backend/src/main.ts`) to only the deployed frontend instead of the
permissive local-dev default.

## Env var summary

| Var | Where | Value |
|---|---|---|
| `DATABASE_URL` | Render (backend) | Neon **pooled** connection string (`-pooler` host) |
| `DIRECT_URL` | Render (backend) | Neon **direct** connection string (no `-pooler`) |
| `FRONTEND_ORIGIN` | Render (backend) | the Vercel deployment URL |
| `NEXT_PUBLIC_API_BASE_URL` | Vercel (frontend) | the Render deployment URL |

## Redeploying

Both Render and Vercel auto-deploy on push to `master` once connected. No manual step needed
for ordinary code changes — only new/changed env vars need to be set again in each dashboard.
