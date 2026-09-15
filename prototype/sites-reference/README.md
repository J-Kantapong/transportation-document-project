# Codex Sites reference prototype

This folder contains the current UI and API reference from the deployed Codex prototype.

- `dist/index.html` is the authored single-page UI source.
- `client/vehicles.js` contains vehicle-entry and Batch import behavior.
- `server/worker.js` and `server/vehicles.js` define the prototype API behavior.
- `db/schema.ts` and `drizzle/` document the current SQLite/D1 schema and migrations.
- `docs/SHARED-PROJECT.md` and `docs/VEHICLE-ENTRY.md` describe the product contract.

Use this folder as a reference when implementing equivalent functionality in `frontend/` and `backend/`. It is not wired to the Next.js/NestJS applications automatically.

The live Sites project identifier and deployment configuration are excluded. No production data or secrets are included.
