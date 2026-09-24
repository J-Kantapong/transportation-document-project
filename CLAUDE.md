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
- Deployments: `master` is production, `dev` is the separate dev environment (own Neon branch, own Render service, Vercel preview). See `DEPLOYMENT.md`.

## Current product state

- Dashboard and five registration categories exist in the prototype.
- Customer database UI supports create, list, and detail views.
- New vehicle registration has four subtasks; only `เพิ่มข้อมูลรถจดใหม่` is implemented.
- Vehicle entry supports Single entry and validated Batch import from `.xlsx` and UTF-8 `.csv`.
- Customer, brand, and finance-company choices come from the database (`/api/finance-companies`, added like brands with a "+ เพิ่มไฟแนนซ์" form; no seed data).
- `ประเภทรถ` is a dropdown with 13 unique user-specified choices.
- งานแจ้งย้ายยามาฮ่า (`/registration/yamaha-relocation/{small,large}`): every daily count entry must carry two attachments, ใบเสร็จ and Report (image or PDF, required on both frontend and backend, added 2026-09-22). `POST /api/yamaha-relocation` is multipart (`date`, `size`, `count`, files `receipt` + `report`). Files live in the shared photo storage (R2 or local disk) under `yamaha-relocation/` and are served by `GET /api/yamaha-relocation/attachments/:id/file`.
- Vehicle entry records the owner type (`บุคคลธรรมดา` / `นิติบุคคล`, required) and an optional finance company. Financed vehicles are stored as a `VehicleOwner` with the finance company as the juristic registered owner and the chosen type as `hirerType`; the submit-documents page (Step 4) shows this automatically and only asks for the owner type on older vehicles that have none. See `frontend/src/lib/vehicle-owner.ts` and `VehiclesService.ownerDataFor`.
- การสลับเลข (added 2026-09-22): split into `รถเก่า กับ รถใหม่` and `รถเก่า กับ รถเก่า` (the latter is an empty placeholder until the user gives its rules). Only cars for now; motorcycles come later. `รถเก่า กับ รถใหม่` stores one `PlateSwap` row per old vehicle (submit date, owner name, engine number, chassis number, brand, old plate, new plate, in that order; the user fixed this on 2026-09-23, engine and chassis are separate required fields here unlike `Vehicle`). Plates are stored as หมวดทะเบียน + เลขทะเบียน on both sides, matching `Vehicle`. The new plate is nullable: the office often doesn't know it when filing, so it can be filled in later from the submitted list or the return page (`PATCH /api/plate-swaps/:id/new-plate`) and both halves are required before confirming the return. A linked new vehicle carries the swap on its own record (`Vehicle.plateSwap` in the API, loaded separately from the vehicle query so a database without the table still works). On the submit-documents page that vehicle shows the swap, has its หมวด/เลข filled in automatically, and cannot be submitted until the swap's documents are confirmed returned (`PLATE_SWAP_PENDING_REASON` in `submission-eligibility.ts`)., a required link to a new vehicle in the new-registration database (`newVehicleId`, searched by chassis; changeable but never cleared), and a fee snapshot. `ยี่ห้อ` of the old vehicle is a dropdown of the `Brand` table, validated server-side. Fees live in `backend/src/plate-swap/plate-swap-fee.ts` (copied in `frontend/src/lib/plate-swap-fee.ts`); No Bill is ลงขัน 200 plus the old vehicle's ค่าอากร 10 (added 2026-09-23): the duty is counted in the No Bill total but excluded from the grand total, where it is shown on its own line. `dutyAmountOf` reads it back from a saved job's No Bill snapshot. Returning documents needs at least one receipt photo (`ReceiptImage.plateSwapId`) and a return date. API `/api/plate-swaps`, pages under `/registration/plate-swap/old-new` (`submit`, `return`), access = `ADMIN` / `STAFF_CAR` write, `ACCOUNTANT` read.
- Deleting a vehicle (added 2026-09-23): soft delete only. `DELETE /api/vehicles/:id` needs a `remark` (mandatory reason)
  and is `ADMIN`-only, as are `GET /api/vehicles/deleted` and `POST /api/vehicles/:id/restore`. `Vehicle.deletedAt` /
  `deletedReason` / `deletedById` hold the current state; every delete and restore also writes a `VehicleEditLog` row so
  repeated cycles stay auditable. `VehicleEditLog.editedById` (added 2026-09-24) records who made each edit, delete, restore or inspection correction (null for rows before then and for scripts). Deleted vehicles are filtered out of every list, queue, search and the customer portal
  (`deletedAt: null` in each `where`). A vehicle cannot be deleted once it has any `DocumentSubmission` (including FAILED),
  any `InvoiceLine`, or is linked as the new vehicle of a `PlateSwap` - fix it with แก้ไข instead. `Vehicle.chassis` is no
  longer `@unique` in Prisma: uniqueness is a Postgres partial unique index `Vehicle_chassis_active_key` over
  `chassis WHERE "deletedAt" IS NULL`, so a deleted chassis can be keyed in again (never use `findUnique({ where: { chassis } })`).
  UI: ลบ button per row plus a "รายการที่ลบแล้ว" panel with กู้คืน, both ADMIN-only, in `/registration/new-vehicle/entry`.
- Duplicate uploads (added 2026-09-24): the same file cannot be uploaded twice. `ReceiptImage`, `PlatePhoto`, `BookPhoto`
  and `YamahaRelocationAttachment` store a SHA-256 `contentHash` (`@unique`, NULL for files uploaded before then); every
  upload endpoint answers 409 `{ error: 'รูปนี้อัพโหลดไปแล้ว' }` (Yamaha: `ไฟล์ใบเสร็จนี้…` / `ไฟล์ Report นี้…`, and ใบเสร็จ =
  Report is rejected) before storing the file or calling the AI. Receipts from step 5 and plate swaps share one table,
  so a photo used as either counts. Deleting a photo frees its hash. Helper: `backend/src/receipts/upload-hash.ts`.
  On top of that, a *warning only* (user's choice, AI can misread) from what the AI read: a step-5 receipt whose
  เลขที่ใบเสร็จ matches a saved `DocumentSubmission.receiptNo` or another photo's reading, or whose chassis already has a
  receipt / is RECEIPT_RECEIVED, gets `extraction.duplicate` (`ReceiptsService.findDuplicate`, re-checked on assign);
  batch uploads with a duplicate are not auto-attached. Plate/book photos use their existing `received` match, now
  styled as a "รูปซ้ำ" warning. Needs `ANTHROPIC_API_KEY`, so it does nothing where AI reading is off.
- Background receipt reading (added 2026-09-25): a camera shot on the capture page is still read immediately (the
  photographer needs the result while holding the receipt), but picking several receipts from the gallery (capture
  page and the "เลือกรูปหลายใบ" tray) uploads 4 at a time with `background=1`: `POST /api/receipts` stores the file,
  sets `ReceiptImage.readPending` and answers at once; `ReceiptsService` reads up to 3 at a time in-process, then
  runs duplicate check + chassis match + save one at a time (manual assign goes through the same lock, and a
  staff-chosen vehicle is kept). Pending rows are re-queued on boot (cleared if AI is off). The page polls
  `GET /api/receipts?ids=a,b` (`frontend/src/lib/receipt-upload.ts`). Only for uploads with no `submissionId`.
  Step 6 plate photos and Step 7 book photos work the same way (camera = immediate, gallery = `background=1`,
  `PlatePhoto.readPending` / `BookPhoto.readPending`); they only save the reading, since matches are computed on every
  `GET .../open`, which the panels poll while a photo is pending. Shared queue: `backend/src/receipts/background-reads.ts`.
- Receipt dates (user's choice 2026-09-25): two separate dates on `DocumentSubmission`. `receiptDate` = the date printed
  on the receipt (the official date; filled from the AI reading, editable in the receipt-check table and popup, flagged
  when unreadable or different from the submit date; defaults to `submitDate`, since DLT issued all 59 checked receipts
  on the submit day). `receiptReceivedDate` = the day the office got the receipt back (auto today on the receipt-check
  page, editable). `POST /api/vehicles/document-submission/receipt-check` entries take an optional `receiptDate`.
  Receipts received before the column existed are backfilled by migration `20260925180000_backfill_receipt_date`
  from the latest photo's AI-read date (Buddhist year converted), else `submitDate`. The AI date is also normalised
  in code (`normalizeReceiptDate`), and the date inputs turn a typed Buddhist year into Gregorian. A saved receipt
  date can be corrected with the "✎ แก้" button in the "ได้ใบเสร็จแล้ว" table
  (`PATCH /api/vehicles/document-submission/:id/receipt-date` `{ receiptDate }`, RECEIPT_RECEIVED only, same access as step 5). The capture
  page (`/receive-receipt/capture`) has no date field and uses the same panel layout as the plate/book capture pages.
- Delivery slips and report (added 2026-09-25): every save on the Delivery page creates one `DeliverySlip` (one customer,
  date and recipient; `slipNo` shown as `DL-00001`) with a `DeliverySlipItem` per vehicle saying what went out this
  time (`receipt` / `book` / `plate`, plus a snapshot of chassis, brand, plate text and receipt number). A later
  plate-only delivery is its own slip. A save may not mix customers. `POST /api/delivery` now also returns
  `slipId` / `slipNo`; `GET /api/delivery/slips?from&to&customerId` and `GET /api/delivery/slips/:id` read them
  (items filtered by the car/moto scope). The page prints the slip for the recipient to sign right after saving;
  `/registration/new-vehicle/delivery/report` lists slips by date range and customer, reprints any slip, prints the
  report, and lists vehicles whose plate is still owed. Slips and the report can also be saved straight to a PDF file
  (`frontend/src/lib/pdf-export.ts`: the same print HTML is rendered to images with `html2canvas-pro` and paged into
  A4 with `jspdf`, both loaded only on click, so Thai text looks exactly as on screen but is not selectable; pages
  break between rows and repeat the table header). No prices anywhere. The `Vehicle` delivery columns are still
  the live state used by the queue and billing. Deliveries saved before this were backfilled by migration
  `20260925200000_add_delivery_slips` (recipient of a later plate delivery read back from `deliveryNote`).
- Owner names at vehicle entry: without finance the form requires `ชื่อผู้ถือกรรมสิทธิ์` (stored in `VehicleOwner.name`); with finance the registered owner is the finance company name (read-only) and the form requires `ชื่อผู้ครอบครอง` (stored in `VehicleOwner.hirerName`).

## Login, roles, and customer portal (added 2026-09-22, branch feature/login)

- Roles (user-decided): `ADMIN` (everything + approve users), `STAFF_ENTRY` (steps 1-3: vehicle entry, transfer notice, inspection, plus brands/finance/owner reference data; all vehicle types), `STAFF_CAR` and `STAFF_MOTO` (steps 4-8: submit documents, receipt, plate, book, Delivery, job sheet; only cars / only motorcycles, where motorcycle = `Vehicle.body` starting with `รย.12-`; holding both = all vehicles; they can read steps 1-3 but not save, except that `STAFF_MOTO` can also save step 2 แจ้งย้าย/ตัดบัญชี for motorcycles, added 2026-09-24: `canEditTransferNotice` in `vehicle-scope.ts` and `auth.ts`), `ACCOUNTANT` (billing + dashboard + read-only on registration data), `DELIVERY` (Delivery page only, no prices), `CUSTOMER` (portal only). Staff roles have no dashboard `/` and cannot add customers (only `ADMIN` can `POST /api/customers`; the add form is hidden for others). One user may hold several staff roles (`User.roles[]`); `CUSTOMER` cannot be combined with staff roles.
- Vehicle-type scoping for steps 4-8 is enforced in `backend/src/auth/vehicle-scope.ts` (a Prisma `where` fragment plus `assertVehicleInScope`) inside the step 4-8 services; the current user reaches services through AsyncLocalStorage (`backend/src/auth/request-context.ts`, opened per request in `main.ts`). Outside an HTTP request (unit tests, scripts) the scope is unrestricted. The frontend mirrors it with `vehicleScopeFor` in `frontend/src/lib/auth.ts` (locks the plate-photo car/moto tab).
- Flow: anyone registers at `/register` (staff tab: name, nickname, email, phone, password x2, requested role; customer tab: contact name, company, phone, email, password x2; no ID-card number) -> status `PENDING` -> Admin approves at `/admin/users`, sets roles and, for customers, links `User.customerId` to a `Customer` row. Only `APPROVED` users can log in. The first admin is created with `npm run seed:admin` in `backend/` (env `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME`); there is no self-registration as admin.
- Auth mechanics: scrypt password hashes and HS256 JWT signed with `AUTH_SECRET` (both via `node:crypto`, no extra dependencies; 12 h TTL). The frontend keeps the token in cookie `td_token` on its own domain and sends `Authorization: Bearer` on every request (`frontend/src/lib/api.ts`); a 401 redirects to `/login`. `frontend/src/proxy.ts` gates pages by the roles in the token payload; the backend re-reads the user from the database on every request (`backend/src/auth/auth.guard.ts`, registered as a global `APP_GUARD`).
- Access policy lives in one place per side: `backend/src/auth/access-policy.ts` (path-prefix rules) and `PAGE_RULES` in `frontend/src/lib/auth.ts`. Change both together.
- Executive overview (added 2026-09-24, branch feature/overview): `/` renders `ExecutiveOverview` for `ADMIN` only (`HomeDashboard` picks by token roles); other roles that can open `/` (ACCOUNTANT) still see the old placeholder until the user defines their own overview. API `GET /api/overview?date=YYYY-MM-DD` (ADMIN-only, read-only) in `backend/src/overview`: daily spend (Bill/No bill from submissions, inspections, transfers, plate swaps, tax renewals, Yamaha), cash collected (Invoice PAID) and billed, money tied up (in process / delivered-unbilled / receivable + aging), a 4-week cash forecast from customers' real days-to-pay, a per-step table split car/motorcycle (done on the chosen day, cost that day, backlog now, oldest, over-SLA; plus plate swap, tax renewal, Yamaha unsplit), a "รถที่ติดขัด" list of individual vehicles over SLA or flagged (inspection failed/expiring/expired, submission failed, receipt missing with unknown cause, waiting on a plate swap), and action alerts. Each vehicle's current queue comes from `waitsFor` in `backend/src/overview/overview-process.ts`, which mirrors the real queue rules. SLA days per step, the 14-day inspection-expiry warning and the forecast defaults are Claude's choices (`STAGES` in `overview-process.ts`, constants in `overview-calculator.ts`); there is no bank balance, so cash is shown as net flow only. The receipt step (done on the day, receipt-vs-Bill series, and the start of the plate/book wait) uses `DocumentSubmission.receiptDate`, the date printed on the receipt (user's choice 2026-09-25), falling back to `receiptReceivedDate` then `submitDate`.
- Customer portal (`/portal`, API `/api/portal/*`): lists the linked company's vehicles with an 8-step status timeline and a "confirm receipt" button (`Vehicle.deliveryConfirmedAt`). It must never expose fees, taxes, or costs. Letting customers add vehicles or documents is a later phase.

