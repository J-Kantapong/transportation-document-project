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
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Render (backend) | same Cloudflare account and token as dev |
| `R2_BUCKET` | Render (backend) | `transport-photos` (same bucket as dev) |
| `R2_PREFIX` | Render (backend) | `production` (set by `render.yaml`): production files live under `production/` |
| `NEXT_PUBLIC_API_BASE_URL` | Vercel (frontend) | the Render deployment URL |

Photo storage setup (bucket, token, testing with `node scripts/check-r2.mjs .env.production`) is in
`CLOUDFLARE-R2.md`. Without the four `R2_*` vars, the backend stores photos on Render's disk, which is
wiped on every deploy, so production must have them.

## Redeploying

Both Render and Vercel auto-deploy on push to `master` once connected. No manual step needed
for ordinary code changes — only new/changed env vars need to be set again in each dashboard.

## Dev environment (branch `dev`)

A second, fully separate deployment for development and testing. Nothing here touches
production: it has its own git branch, its own database, its own backend service, and its own
frontend URL. Production keeps deploying from `master` exactly as above.

| | Production | Dev |
|---|---|---|
| Git branch | `master` | `dev` |
| Neon database | branch `main` | branch `dev` (copy of `main` at creation time) |
| Render service | `transportation-document-backend` | `transportation-document-backend-dev` |
| Vercel | Production deployment | Preview deployment of branch `dev` (stable URL `https://transportation-document-project-git-dev-tradeinter.vercel.app`) |

Workflow: feature branches merge into `dev` (auto-deploys the dev environment); when `dev` is
verified, merge `dev` into `master` (auto-deploys production). Schema migrations run against the
dev database first, on the dev deploy, and only reach production when `master` deploys.

### 1. Neon: create the `dev` branch

Neon dashboard → project `transportation-document-project` → **Branches** → **Create branch**:
name `dev`, parent `main`, "Include data" (a point-in-time copy, so dev starts with realistic
data; wipe it later with `backend/scripts/dev-wipe-vehicle-data.mjs` if you want a clean slate).
Copy the branch's **pooled** and **direct** connection strings — they differ from `main`'s by the
endpoint host. Or with the CLI:

```bash
npx neonctl branches create --project-id small-river-26857171 --name dev --parent main
```

```bash
npx neonctl connection-string dev --project-id small-river-26857171 --pooled
```

```bash
npx neonctl connection-string dev --project-id small-river-26857171
```

To reset the dev database to match production again later, delete the `dev` branch and
recreate it from `main` (then update the Render env vars below, since the endpoint host changes).

### 2. Render: the dev backend service

`render.yaml` now declares two services; the second one, `transportation-document-backend-dev`,
deploys from the `dev` branch. Render only reads `render.yaml` from the branch the Blueprint was
created on (`master`), so this change has to be on `master` before it shows up.

- **If production was created from the Blueprint**: Render dashboard → **Blueprints** → the
  blueprint for this repo → **Sync** (or it syncs itself on the next `master` push). It proposes
  the new dev service; before approving, fill in `DATABASE_URL` and `DIRECT_URL` with the Neon
  **dev-branch** strings from step 1.
- **If production was created by hand**: **New +** → **Web Service** → same repo, **Branch**
  `dev`, Root Directory `backend`, Build Command
  `npm ci && npx prisma generate && npx prisma migrate deploy && npm run build`, Start Command
  `npm run start:prod`, name `transportation-document-backend-dev`, and the two Neon dev-branch
  env vars.

Leave `FRONTEND_ORIGIN` unset on dev so any Vercel preview URL can call it. `ANTHROPIC_API_KEY`
is optional (photos are stored without AI reading if it's empty). The four `R2_*` credentials are the
same bucket and token as production; `R2_PREFIX` = `DEV` (set by `render.yaml`) so dev files live
under `DEV/` while production uses the `production/` folder.

The service URL will be `https://transportation-document-backend-dev.onrender.com`.

### 3. Vercel: point the `dev` preview at the dev backend

Vercel already builds a Preview deployment for every non-`master` branch that is pushed, so the
`dev` branch gets a frontend automatically. It just needs to know about the dev backend:

1. Vercel → project `transportation-document-project` → **Settings** → **Environment Variables**
   → **Add**: `NEXT_PUBLIC_API_BASE_URL` = `https://transportation-document-backend-dev.onrender.com`,
   environment **Preview** only, and (recommended) limit it to the branch `dev` using the
   "Preview" → branch selector. Production keeps its own value.
2. Push `dev` (or redeploy the latest `dev` preview) so the build picks the variable up —
   `NEXT_PUBLIC_*` values are baked in at build time.
3. Optional, to keep dev private: **Settings** → **Deployment Protection** → enable **Vercel
   Authentication** for Preview deployments, so only members of the Vercel team can open it.

The stable URL for the branch is `https://transportation-document-project-git-dev-tradeinter.vercel.app`
(each commit also gets its own throwaway URL).

### 4. Local development against the dev database

Point your local backend at the Neon `dev` branch instead of `main` so local work never touches
production data: in `backend/.env`, set `DATABASE_URL` and `DIRECT_URL` to the dev-branch strings
from step 1. `npm run dev` at the repo root works unchanged.

### Dev env var summary

| Var | Where | Value |
|---|---|---|
| `DATABASE_URL` | Render (`…-backend-dev`) | Neon **dev branch** pooled connection string |
| `DIRECT_URL` | Render (`…-backend-dev`) | Neon **dev branch** direct connection string |
| `FRONTEND_ORIGIN` | Render (`…-backend-dev`) | leave unset (allow any origin) |
| `R2_*` (4 vars) | Render (`…-backend-dev`) | same bucket and token as production; `R2_PREFIX` = `DEV` |
| `NEXT_PUBLIC_API_BASE_URL` | Vercel, **Preview** scope, branch `dev` | `https://transportation-document-backend-dev.onrender.com` |
