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
  batch uploads with a duplicate are not auto-attached. Plate/book photos no longer
  use AI (see below). Needs `ANTHROPIC_API_KEY`, so it does nothing where AI reading is off.
- Background receipt reading (added 2026-09-25): a camera shot on the capture page is still read immediately (the
  photographer needs the result while holding the receipt), but picking several receipts from the gallery (capture
  page and the "เลือกรูปหลายใบ" tray) uploads 4 at a time with `background=1`: `POST /api/receipts` stores the file,
  sets `ReceiptImage.readPending` and answers at once; `ReceiptsService` reads up to 3 at a time in-process, then
  runs duplicate check + chassis match + save one at a time (manual assign goes through the same lock, and a
  staff-chosen vehicle is kept). Pending rows are re-queued on boot (cleared if AI is off). The page polls
  `GET /api/receipts?ids=a,b` (`frontend/src/lib/receipt-upload.ts`). Only for uploads with no `submissionId`.
  Shared queue: `backend/src/receipts/background-reads.ts` (receipts only since 2026-09-26).
- No AI for plates and books (user 2026-09-26): the AI reading, matching, photo trays and phone capture pages of
  Step 6/7 were removed (`plate-reader`, `plate-reading`, `book-reader`, `book-reading`, `PlatePhotoPanel`,
  `BookPhotoPanel`, `scripts/plate-bench.ts`; old `/capture` URLs redirect to the chooser). Each pending row in the
  `/car` or `/moto` queue has "📷 แนบรูปป้าย" / "แนบรูปเล่ม" plus a date: picking a photo calls
  `POST /api/plate-photos/attach` or `/api/book-photos/attach` (multipart `file`, `vehicleId`, `date`), which stores the
  photo (closed, duplicate check kept) and sets `plateReceivedDate` + `platePhotoId` / `bookReceivedDate` + `bookPhotoId`
  at once. A photo is still required for every vehicle. `extraction` / `readPending` columns stay for old rows.
  The pending queue is a list of ใบยื่น cards styled like the receipt page ("date · job-sheet group · customer" on the
  left, "N คัน · รับป้ายแล้ว x · รอรับป้าย y" on the right; group logic in `lib/job-sheet.ts`, shared with the receipt
  page), oldest submit date first; `GET /api/vehicles/receiving/:step/pending` rows carry `submitDate` + `urgent` +
  `submittedAt` of the latest submission (user 2026-09-26). Cards start folded (click to show that sheet's table, plus
  ขยายทั้งหมด / พับทั้งหมด / เลือกทุกใบ); searching opens all, and a `?focus=` link opens its sheet. N = how many vehicles
  the whole ใบยื่น submitted (read from `GET /api/vehicles/document-submission?date=`); a sheet with vehicles still
  waiting for a receipt or FAILED is orange with "⚠ ยื่นไม่ครบ".
  Both queues show เลขที่ใบเสร็จ. Cars in a ใบยื่น are listed in submission order by default (`submittedAt` = the latest
  submission's createdAt, i.e. the printed job-sheet order) with a "เรียงตามหมวด" toggle (`comparePlate`: 1กก 1, 1กก 2, 1กข 1).
  A filter bar (วันที่ยื่น from/to; เจ้าของงาน dropdown; เลขที่ใบเสร็จ, เลขตัวรถ, ทะเบียน contain) sits above the list; each ใบยื่น card has a checkbox,
  and "🖨 ปริ้นชุดที่เลือก" prints the ticked sheets, one table per sheet in the current order, for handing to the DLT
  (`lib/receiving-print.ts`, user 2026-09-26).
- Receipt dates (user's choice 2026-09-25): two separate dates on `DocumentSubmission`. `receiptDate` = the date printed
  on the receipt (the official date; filled from the AI reading, editable in the receipt-check table and popup, flagged
  when unreadable or different from the submit date; defaults to `submitDate`, since DLT issued all 59 checked receipts
  on the submit day). `receiptReceivedDate` = the day the office got the receipt back (auto today on the receipt-check
  page, editable). `POST /api/vehicles/document-submission/receipt-check` entries take an optional `receiptDate`.
  Receipts received before the column existed are backfilled by migration `20260925180000_backfill_receipt_date`
  from the latest photo's AI-read date (Buddhist year converted), else `submitDate`. The AI date is also normalised
  in code (`normalizeReceiptDate`), and the date inputs turn a typed Buddhist year into Gregorian. A saved receipt
  date can be corrected with the "✎ แก้" button in the "ได้ใบเสร็จแล้ว" table
  (`PATCH /api/vehicles/document-submission/:id/receipt-date` `{ receiptDate, remark }`, RECEIPT_RECEIVED only, same access as step 5; user 2026-09-25: `remark` is mandatory and logged to `VehicleEditLog`, and the date must lie between the submit date and the receipt-received date / today). The page is split by vehicle type (user 2026-09-25): `/receive-receipt` only picks รถยนต์ / มอเตอร์ไซค์ (limited to the user's vehicle scope) and the work happens on `/receive-receipt/car` and `/receive-receipt/moto`; vehicles left without a receipt stay in their original ใบยื่น, flagged "ยังขาด N คัน" (the separate "ค้างจากใบก่อน" group was removed). Receive plate and receive book follow the same split (user 2026-09-26): `/receive-plate` and `/receive-book` are choosers (`components/VehicleKindChooser.tsx`) and the queues live on `/car` and `/moto` (`ReceivePlateQueue`, `ReceiveBookQueue`). The capture
  page (`/receive-receipt/capture`) has no date field and uses the same panel layout as the plate/book capture pages.
- Cancelling a submission (added 2026-09-25): each PENDING row (cars and motorcycles) on
  `/registration/new-vehicle/submit-documents/records` has "ยกเลิก" (ADMIN / STAFF_CAR / STAFF_MOTO, in their vehicle
  scope). Attached receipt photos are detached back to the unmatched pool (the dialog warns about it). `POST /api/vehicles/document-submission/:id/cancel` `{ remark }` deletes the submission so the vehicle returns
  to the submit queue and can be submitted again with freshly calculated fees; a snapshot + remark goes to
  `VehicleEditLog` (the cash-advance refund is added once that feature lands). Unlike FAILED, nothing is kept. Editing a single submission's price
  was tried and dropped (user 2026-09-25); changing fee rates for future submissions is still undecided.
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
  Fixing a mistyped slip (user 2026-09-26), on the report page, ADMIN every slip / STAFF_CAR car slips / STAFF_MOTO
  motorcycle slips (DELIVERY read-only): "✎ แก้" = `PATCH /api/delivery/slips/:id` `{ recipient, date, remark }`
  (date of a billed vehicle cannot change; book date may not be after a later plate slip); "ยกเลิก" =
  `POST /api/delivery/slips/:id/cancel` `{ vehicleIds, remark }`, whole slip or chosen vehicles: the vehicle's
  delivery columns are cleared so it returns to the Delivery queue (a plate-only item only clears the plate date).
  Nothing is deleted: `DeliverySlipItem.cancelledAt/cancelReason/cancelledById`, and `DeliverySlip.cancelled*` once
  every item is cancelled (shown "ยกเลิกแล้ว", DL numbers stay continuous, left out of counts/prints). Blocked for a
  billed vehicle (void the invoice first) and for a book delivery whose plate went later on another slip (cancel that
  slip first). Remark is mandatory and every change is logged to `VehicleEditLog`. To catch the usual mistake (the
  date) before it happens, "บันทึกส่งงาน" on the Delivery page first opens a confirm popup (date, days from today in
  orange when not today, customer, recipient, vehicle count by what goes out); future dates are allowed (user).
  Receipts are not delivered with the job (user 2026-09-26): they go to the customer with the billing statement
  (ใบวางบิล, not built yet), so new `DeliverySlipItem.receipt` is always false, slips/report/prints show only เล่ม +
  ป้าย (receipt number kept for reference), and the Delivery queue shows the receipt only as มีแล้ว / รอ (still
  required before delivery). Slip logic keys on `book` (book = first delivery, no book + plate = plate-only slip).
  Printed slip layout (user 2026-09-26): company header from `DELIVERY_HEADER` in `frontend/src/lib/company-profile.ts`
  (no logo; phone 0655194565 differs from the invoice header) with a "ใบส่งงาน" box for DL number and date; columns
  ลำดับ, เลขตัวถัง, เลขทะเบียน, ยี่ห้อ, ชื่อเจ้าของ (+ เล่ม / ป้าย ticks). ชื่อเจ้าของ = `VehicleOwner.hirerName` when
  financed, else `name` (never the finance company), read live via `GET /api/delivery/slips` items `ownerName`. Every row
  is one line of fixed height: fixed column widths and a small script in the print HTML shrinks long text to fit (down
  to 6pt, then "…"). Long slips repeat the table header per page, the total row prints once, and the note + signature
  block never splits (it starts with a "ใบส่งงานเลขที่ … · รวม N คัน" line in case it lands on its own page;
  `.tail` is kept together by `pdf-export.ts` too).
  The Delivery page is a list of ใบยื่น (lot) cards like the receive plate/book queues (user 2026-09-26: work finishes
  per lot but not always all of it): lot = latest submission's submit date + job-sheet group + customer; every vehicle
  of the lot is listed with ใบเสร็จ / เล่ม / ป้าย status (มีแล้ว / รอ / ส่งแล้ว), only queue vehicles can be ticked,
  ticking across lots is allowed for one customer, and the save form is a sticky bar at the bottom. `GET
  /api/delivery/queue` returns `{ vehicles, lotVehicles }` (the other vehicles of those lots, display only); rows carry
  `submitDate`, `urgent`, `submittedAt`, `submissionStatus`, `receiptReceived`, `bookReceived`.
- Saved-vehicle list on `/registration/new-vehicle/entry` (added 2026-09-25): `GET /api/vehicles` returns
  `{ vehicles, hasMore }`, 100 at a time newest-first (`offset` for "โหลดเพิ่มอีก 100 คัน", `limit` up to 1,000 so a
  reload after edit/delete keeps what is open). `q` searches the whole database (chassis, engine, plate incl.
  "4กข 4444", customer name/company, owner/hirer name); `from` / `to` (YYYY-MM-DD, inclusive) filter `Vehicle.date`.
  The date boxes are DD/MM/YYYY and accept a Buddhist year. The search/date matching lives in
  `backend/src/vehicles/vehicle-list-filter.ts`, shared with the vehicle search page below.
- Vehicle search page (added 2026-09-25): main menu "ค้นหารถ" at `/vehicles`, open to `ADMIN`, `STAFF_ENTRY`, `STAFF_CAR`,
  `STAFF_MOTO`, `ACCOUNTANT` (read-only; `STAFF_CAR` / `STAFF_MOTO` only see their vehicle type, `STAFF_ENTRY` sees all).
  `GET /api/vehicle-search?q=&from=&to=&status=&kind=car|moto&offset=` returns `{ vehicles, total, all, hasMore, counts }`,
  100 per page. Each vehicle's `statuses` (the steps it is waiting on, days waited, late vs `STAGES` SLA, flags, reason)
  come from `waitsFor` in `overview-process.ts`, so they match the real queues; empty = finished (delivered, plate
  delivered, billed). `status` = a stage key, `done`, or `problem` (late or flagged). The filters live in the URL so
  refresh and back work. Typing filters live (300 ms debounce) and highlights the match. "ไปที่งาน →" opens the stage's
  work page with `?focus=<chassis>` (`frontend/src/lib/vehicle-focus.ts`, stage → page map there): `FocusVehicleRow`
  in `AppShell` waits for that vehicle's table row, scrolls to it and highlights it (or shows "ไม่พบรถ…" after 15 s).
  Pages that hide rows reveal it themselves: inspection jumps to the right page of 10, the step-4 queue prefills its
  chassis box, the receipt / plate / book links go to that vehicle's `/car` or `/moto` page (the receipt page opens the vehicle's sheet), and
  Delivery/billing select the vehicle's customer.
- Date inputs (user's choice 2026-09-25): every วว/ดด/ปปปป box is `components/DateInput.tsx`, which keeps typing
  (each caller still formats / converts a Buddhist year as before) and adds a calendar button that opens a hidden
  native `<input type="date">` via `showPicker()` and hands back "วว/ดด/ปปปป". Use it for any new date field.
  `CashAdvancePage` (another chat's work in progress) was not converted yet.
- Underline tabs are URLs (user's choice 2026-09-25, `components/PageTabs.tsx`): `/inspection` + `/inspection/result`,
  `/entry` + `/entry/batch`, `/register` + `/register/customer` (the second route re-exports the first page, which
  picks its tab from `usePathname`), and the submitted-records car/moto tabs use `?tab=moto` so their filters stay.
  The tax-renewal "เลือกรถจากระบบ / กรอกข้อมูลรถเอง" toggle stays in-page because it is part of an unsaved form.
- Step 4 submit flow in 4 URLs (user's redesign 2026-09-25, `frontend/src/components/submit-flow/`); every step can
  go back to edit the earlier ones (step bar links + back buttons):
  1. `/submit` pick vehicles (queue + filters + "วางเลขตัวถังหลายคัน", no per-vehicle form, no "ยื่นได้ถึง" column).
  2. `/submit/settings` one table where every option is set in the row, with the full Bill / No bill / tax / อากร
     lines under each vehicle (user's choice: the detail and the editing live here); the only bulk control is
     "งานด่วนทุกคัน / ไม่ด่วนทุกคัน" (no select checkboxes here, ticking twice was confusing); the rarer options are
     small checkboxes right in the row (รวมค่าแผ่นป้าย under the plate cell; ด่วน + แจ้งย้ายออก (car) / หยุดใช้ย้ายออก
     (moto) in the ตัวเลือก column; no "เพิ่มเติม" button); incomplete rows (owner type, plate number when requested,
     pricing error) block going on. The submit date input lives here too (user's choice) and may be a future date,
     since jobs are sometimes keyed in advance: the screen does no date-based eligibility check (the step-1 queue is
     loaded for today and not tied to the submit date); the backend still enforces the 90-day rule for the chosen
     date when submitting, and any vehicle it rejects shows up with its reason in step 4.
  3. `/submit/review` a plain read-only table, one row per vehicle: chassis, customer, brand/body, Bill (fees + tax),
     No bill (without อากร), อากร, รวม (without อากร), plus a totals row, then "ยืนยันยื่น".
  4. `/submit/done` the vehicles just submitted, grouped like the job sheets (รย.1 ธรรมดา / ด่วน, รย.2+3, มอเตอร์ไซค์
     ธรรมดา / ด่วน) with "ปริ้นใบส่งงาน" per group, reusing `GroupTable` + `JobSheetPrintDialog` from the records view
     (records re-read with `GET /api/vehicles/document-submission?date=`); failures listed with reasons and kept
     selected so they can be fixed and resubmitted.
  State and pricing live in `submit/layout.tsx` (`SubmitFlowProvider`), so moving between steps and the back button
  keep them, but a refresh starts over: the localStorage draft was removed (user's choice) and the old
  `submit-documents-draft-v1` key is deleted on load. Pricing reuses `POST /api/vehicles/document-submission/preview-bulk`
  and submit `POST .../document-submission/bulk`, unchanged. The submit deadline moved to the inspection page:
  `InspectionVehicle.submitted` / `submitDeadline` (pass date + 89 days, null once submitted) shown as "ยื่นได้ถึง"
  in the completed-inspections table.
- Owner names at vehicle entry: without finance the form requires `ชื่อผู้ถือกรรมสิทธิ์` (stored in `VehicleOwner.name`); with finance the registered owner is the finance company name (read-only) and the form requires `ชื่อผู้ครอบครอง` (stored in `VehicleOwner.hirerName`).

## Login, roles, and customer portal (added 2026-09-22, branch feature/login)

- Roles (user-decided): `ADMIN` (everything + approve users), `STAFF_ENTRY` (steps 1-3: vehicle entry, transfer notice, inspection, plus brands/finance/owner reference data; all vehicle types), `STAFF_CAR` and `STAFF_MOTO` (steps 4-8: submit documents, receipt, plate, book, Delivery, job sheet; only cars / only motorcycles, where motorcycle = `Vehicle.body` starting with `รย.12-`; holding both = all vehicles; they can read steps 1-3 but not save, except that `STAFF_MOTO` can also save step 2 แจ้งย้าย/ตัดบัญชี for motorcycles, added 2026-09-24: `canEditTransferNotice` in `vehicle-scope.ts` and `auth.ts`), `ACCOUNTANT` (billing + dashboard + read-only on registration data), `DELIVERY` (Delivery page only, no prices), `CUSTOMER` (portal only). Staff roles have no dashboard `/` and cannot add customers (only `ADMIN` can `POST /api/customers`; the add form is hidden for others). One user may hold several staff roles (`User.roles[]`); `CUSTOMER` cannot be combined with staff roles.
- Vehicle-type scoping for steps 4-8 is enforced in `backend/src/auth/vehicle-scope.ts` (a Prisma `where` fragment plus `assertVehicleInScope`) inside the step 4-8 services; the current user reaches services through AsyncLocalStorage (`backend/src/auth/request-context.ts`, opened per request in `main.ts`). Outside an HTTP request (unit tests, scripts) the scope is unrestricted. The frontend mirrors it with `vehicleScopeFor` in `frontend/src/lib/auth.ts` (locks the plate-photo car/moto tab).
- Flow: anyone registers at `/register` (staff tab: name, nickname, email, phone, password x2, requested role; customer tab: contact name, company, phone, email, password x2; no ID-card number) -> status `PENDING` -> Admin approves at `/admin/users`, sets roles and, for customers, links `User.customerId` to a `Customer` row. Only `APPROVED` users can log in. The first admin is created with `npm run seed:admin` in `backend/` (env `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME`); there is no self-registration as admin.
- Auth mechanics: scrypt password hashes and HS256 JWT signed with `AUTH_SECRET` (both via `node:crypto`, no extra dependencies; 12 h TTL). The frontend keeps the token in cookie `td_token` on its own domain and sends `Authorization: Bearer` on every request (`frontend/src/lib/api.ts`); a 401 redirects to `/login`. `frontend/src/proxy.ts` gates pages by the roles in the token payload; the backend re-reads the user from the database on every request (`backend/src/auth/auth.guard.ts`, registered as a global `APP_GUARD`).
- Access policy lives in one place per side: `backend/src/auth/access-policy.ts` (path-prefix rules) and `PAGE_RULES` in `frontend/src/lib/auth.ts`. Change both together.
- Executive overview (added 2026-09-24, branch feature/overview): `/` renders `ExecutiveOverview` for `ADMIN` only (`HomeDashboard` picks by token roles); other roles that can open `/` (ACCOUNTANT) still see the old placeholder until the user defines their own overview. API `GET /api/overview?date=YYYY-MM-DD` (ADMIN-only, read-only) in `backend/src/overview`: daily spend (Bill/No bill from submissions, inspections, transfers, plate swaps, tax renewals, Yamaha), cash collected (Invoice PAID) and billed, money tied up (in process / delivered-unbilled / receivable + aging), a 4-week cash forecast from customers' real days-to-pay, a per-step table split car/motorcycle (done on the chosen day, cost that day, backlog now, oldest, over-SLA; plus plate swap, tax renewal, Yamaha unsplit), a "รถที่ติดขัด" list of individual vehicles over SLA or flagged (inspection failed/expiring/expired, submission failed, receipt missing with unknown cause, waiting on a plate swap), and action alerts. Each vehicle's current queue comes from `waitsFor` in `backend/src/overview/overview-process.ts`, which mirrors the real queue rules. SLA days per step, the 14-day inspection-expiry warning and the forecast defaults are Claude's choices (`STAGES` in `overview-process.ts`, constants in `overview-calculator.ts`); there is no bank balance, so cash is shown as net flow only. The receipt step (done on the day, receipt-vs-Bill series, and the start of the plate/book wait) uses `DocumentSubmission.receiptDate`, the date printed on the receipt (user's choice 2026-09-25), falling back to `receiptReceivedDate` then `submitDate`.
- Customer portal (`/portal`, API `/api/portal/*`): lists the linked company's vehicles with an 8-step status timeline and a "confirm receipt" button (`Vehicle.deliveryConfirmedAt`). It must never expose fees, taxes, or costs. Letting customers add vehicles or documents is a later phase.

