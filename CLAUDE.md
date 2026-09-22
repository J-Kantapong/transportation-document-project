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
- งานแจ้งย้ายยามาฮ่า (`/registration/yamaha-relocation/{small,large}`): every daily count entry must carry two attachments, ใบเสร็จ and Report (image or PDF, required on both frontend and backend, added 2026-09-22). `POST /api/yamaha-relocation` is multipart (`date`, `size`, `count`, files `receipt` + `report`). Files live in the shared photo storage (R2 or local disk) under `yamaha-relocation/` and are served by `GET /api/yamaha-relocation/attachments/:id/file`.
- การสลับเลข (added 2026-09-22): split into `รถเก่า กับ รถใหม่` and `รถเก่า กับ รถเก่า` (the latter is an empty placeholder until the user gives its rules). Only cars for now; motorcycles come later. `รถเก่า กับ รถใหม่` stores one `PlateSwap` row per old vehicle (submit date, owner name, engine number, chassis number, brand, old plate, new plate, in that order; the user fixed this on 2026-09-23, engine and chassis are separate required fields here unlike `Vehicle`). Plates are stored as หมวดทะเบียน + เลขทะเบียน on both sides, matching `Vehicle`. The new plate is nullable: the office often doesn't know it when filing, so it can be filled in later from the submitted list or the return page (`PATCH /api/plate-swaps/:id/new-plate`) and both halves are required before confirming the return. A linked new vehicle carries the swap on its own record (`Vehicle.plateSwap` in the API, loaded separately from the vehicle query so a database without the table still works). On the submit-documents page that vehicle shows the swap, has its หมวด/เลข filled in automatically, and cannot be submitted until the swap's documents are confirmed returned (`PLATE_SWAP_PENDING_REASON` in `submission-eligibility.ts`)., a required link to a new vehicle in the new-registration database (`newVehicleId`, searched by chassis; changeable but never cleared), and a fee snapshot. `ยี่ห้อ` of the old vehicle is a dropdown of the `Brand` table, validated server-side. Fees live in `backend/src/plate-swap/plate-swap-fee.ts` (copied in `frontend/src/lib/plate-swap-fee.ts`); No Bill is ลงขัน 200 plus the old vehicle's ค่าอากร 10 (added 2026-09-23): the duty is counted in the No Bill total but excluded from the grand total, where it is shown on its own line. `dutyAmountOf` reads it back from a saved job's No Bill snapshot. Returning documents needs at least one receipt photo (`ReceiptImage.plateSwapId`) and a return date. API `/api/plate-swaps`, pages under `/registration/plate-swap/old-new` (`submit`, `return`), access = `ADMIN` / `STAFF_CAR` write, `ACCOUNTANT` read.
- Owner names at vehicle entry: without finance the form requires `ชื่อผู้ถือกรรมสิทธิ์` (stored in `VehicleOwner.name`); with finance the registered owner is the finance company name (read-only) and the form requires `ชื่อผู้ครอบครอง` (stored in `VehicleOwner.hirerName`).

## Login, roles, and customer portal (added 2026-09-22, branch feature/login)

- Roles (user-decided): `ADMIN` (everything + approve users), `STAFF_ENTRY` (steps 1-3: vehicle entry, transfer notice, inspection, plus brands/finance/owner reference data; all vehicle types), `STAFF_CAR` and `STAFF_MOTO` (steps 4-8: submit documents, receipt, plate, book, Delivery, job sheet; only cars / only motorcycles, where motorcycle = `Vehicle.body` starting with `รย.12-`; holding both = all vehicles; they can read steps 1-3 but not save), `ACCOUNTANT` (billing + dashboard + read-only on registration data), `DELIVERY` (Delivery page only, no prices), `CUSTOMER` (portal only). Staff roles have no dashboard `/` and cannot add customers (only `ADMIN` can `POST /api/customers`; the add form is hidden for others). One user may hold several staff roles (`User.roles[]`); `CUSTOMER` cannot be combined with staff roles.
- Vehicle-type scoping for steps 4-8 is enforced in `backend/src/auth/vehicle-scope.ts` (a Prisma `where` fragment plus `assertVehicleInScope`) inside the step 4-8 services; the current user reaches services through AsyncLocalStorage (`backend/src/auth/request-context.ts`, opened per request in `main.ts`). Outside an HTTP request (unit tests, scripts) the scope is unrestricted. The frontend mirrors it with `vehicleScopeFor` in `frontend/src/lib/auth.ts` (locks the plate-photo car/moto tab).
- Flow: anyone registers at `/register` (staff tab: name, nickname, email, phone, password x2, requested role; customer tab: contact name, company, phone, email, password x2; no ID-card number) -> status `PENDING` -> Admin approves at `/admin/users`, sets roles and, for customers, links `User.customerId` to a `Customer` row. Only `APPROVED` users can log in. The first admin is created with `npm run seed:admin` in `backend/` (env `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME`); there is no self-registration as admin.
- Auth mechanics: scrypt password hashes and HS256 JWT signed with `AUTH_SECRET` (both via `node:crypto`, no extra dependencies; 12 h TTL). The frontend keeps the token in cookie `td_token` on its own domain and sends `Authorization: Bearer` on every request (`frontend/src/lib/api.ts`); a 401 redirects to `/login`. `frontend/src/proxy.ts` gates pages by the roles in the token payload; the backend re-reads the user from the database on every request (`backend/src/auth/auth.guard.ts`, registered as a global `APP_GUARD`).
- Access policy lives in one place per side: `backend/src/auth/access-policy.ts` (path-prefix rules) and `PAGE_RULES` in `frontend/src/lib/auth.ts`. Change both together.
- Customer portal (`/portal`, API `/api/portal/*`): lists the linked company's vehicles with an 8-step status timeline and a "confirm receipt" button (`Vehicle.deliveryConfirmedAt`). It must never expose fees, taxes, or costs. Letting customers add vehicles or documents is a later phase.

