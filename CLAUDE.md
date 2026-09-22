# Transportation document project

This private repository is the shared development surface for the user, Claude Code, and Codex.

## Repository structure

- `frontend/`: Next.js application created for the production implementation.
- `backend/`: NestJS application created for the production database/API implementation.
- `prototype/sites-reference/`: the latest working UI and database prototype designed in Codex and published separately through OpenAI Sites.

## Collaboration rules

- Read `prototype/sites-reference/docs/SHARED-PROJECT.md` and `prototype/sites-reference/docs/VEHICLE-ENTRY.md` before implementing the matching features in `frontend/` or `backend/`.
- Treat the prototype as the product specification and visual reference. Port features into the existing Next.js and NestJS applications; do not replace those applications with the prototype runtime.
- Preserve the Thai labels, navigation, 7 customer fields, 16 vehicle-entry fields (the original 12 plus `ประเภทเจ้าของรถ`, `ไฟแนนซ์`, `ชื่อผู้ถือกรรมสิทธิ์` and `ชื่อผู้ครอบครอง`, added 2026-09-22), 77-province list, and the 13 unique vehicle-type choices unless the user changes them.
- The user defines workflows incrementally. Do not invent fields or workflows for registration tasks that remain empty.
- Keep frontend and backend contracts documented when either changes.
- Do not commit credentials, production customer data, local database files, or deployment tokens.
- Do not deploy or make this repository public unless the user explicitly asks.

## Current product state

- Dashboard and five registration categories exist in the prototype.
- Customer database UI supports create, list, and detail views.
- New vehicle registration has four subtasks; only `เพิ่มข้อมูลรถจดใหม่` is implemented.
- Vehicle entry supports Single entry and validated Batch import from `.xlsx` and UTF-8 `.csv`.
- Customer, brand, and finance-company choices come from the database (`/api/finance-companies`, added like brands with a "+ เพิ่มไฟแนนซ์" form; no seed data).
- `ประเภทรถ` is a dropdown with 13 unique user-specified choices.
- Vehicle entry records the owner type (`บุคคลธรรมดา` / `นิติบุคคล`, required) and an optional finance company. Financed vehicles are stored as a `VehicleOwner` with the finance company as the juristic registered owner and the chosen type as `hirerType`; the submit-documents page (Step 4) shows this automatically and only asks for the owner type on older vehicles that have none. See `frontend/src/lib/vehicle-owner.ts` and `VehiclesService.ownerDataFor`.
- Owner names at vehicle entry: without finance the form requires `ชื่อผู้ถือกรรมสิทธิ์` (stored in `VehicleOwner.name`); with finance the registered owner is the finance company name (read-only) and the form requires `ชื่อผู้ครอบครอง` (stored in `VehicleOwner.hirerName`).

