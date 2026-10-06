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
- งานแจ้งย้ายยามาฮ่า (`/registration/yamaha-relocation/{small,large}`): every daily count entry must carry ใบเสร็จ and Report attachments, one or more files each (max 10 per kind; image or PDF, required on both frontend and backend, added 2026-09-22; multiple files 2026-09-30, migration `20260930100000_yamaha_multiple_attachments`). `POST /api/yamaha-relocation` is multipart (`date`, `size`, `count`, files `receipt` + `report`, repeatable). Files live in the shared photo storage (R2 or local disk) under `yamaha-relocation/` and are served by `GET /api/yamaha-relocation/attachments/:id/file`.
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
  `VehicleEditLog` and the cash ledger is refunded. Unlike FAILED, nothing is kept. Editing a single submission's price
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
  (the book date of a billed vehicle cannot change; book date may not be after a later plate slip); "ยกเลิก" =
  `POST /api/delivery/slips/:id/cancel` `{ vehicleIds, remark }`, whole slip or chosen vehicles: the vehicle's
  delivery columns are cleared so it returns to the Delivery queue (a plate-only item only clears the plate date).
  Nothing is deleted: `DeliverySlipItem.cancelledAt/cancelReason/cancelledById`, and `DeliverySlip.cancelled*` once
  every item is cancelled (shown "ยกเลิกแล้ว", DL numbers stay continuous, left out of counts/prints). Blocked for the
  book item of a billed vehicle (void the invoice first; plate-only items of billed vehicles stay editable and
  cancellable because the invoice keeps only the book date, user 2026-09-27) and for a book delivery whose plate went later on another slip (cancel that
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
  Row actions (user 2026-10-05): "🖼 รูป" opens a dialog with that vehicle's receipt / plate / book photos
  (`GET /api/vehicles/receiving/photos?vehicleId=`, same access as the receipt page: ADMIN / STAFF_CAR / STAFF_MOTO /
  ACCOUNTANT, so STAFF_ENTRY does not see the button) and "✎ แก้ไข" (ADMIN / STAFF_ENTRY) opens the entry page's edit form
  with `?focus=<chassis>&edit=1&returnTo=/vehicles?<current filters>`; saving returns to the search with the same filters
  (`returnToAfterEdit` accepts only `/vehicles` and `/accounting/billing`).
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
- Production bug audit (2026-09-27): a full audit fixed 57 problems. Rules and contracts that changed:
  - Stale screens and races: queue pages reload on focus and after a refused save. Saves carry what the user saw and the server answers 409 when it changed: transfer notice `expectedTransferDone`, `POST /api/delivery` `{ items: [{ vehicleId, kind }], date, recipient, note }` (kind `DONE` = book and plate both delivered, never saveable), inspection send/result never overwrite an existing one. Status changes use conditional writes or row locks: `submission-lock.ts` locks DocumentSubmission rows (always before ReceiptImage rows); bulk submit saves each vehicle in its own transaction with a Vehicle row lock, 8 at a time, createdAt in pick order, max 1,000 per request (the page sends 50); invoices lock their Vehicle rows `FOR UPDATE`; slip edit/cancel re-check "not billed" in the same transaction.
  - Dates: server "today" is Bangkok (`bangkokToday()` in `overview-calculator.ts`); every date box accepts a Buddhist year. Order enforced: transfer completion <= today; inspection send >= transfer completion (fallback entry date); result between send and today; submitDate <= receiptDate <= receiptReceivedDate <= today; plate/book received date between the receipt date (fallback submit date) and today; paid date between issue date and today.
  - Corrections with a mandatory reason, logged to VehicleEditLog: `PATCH /api/vehicles/:id/inspection-sent-correction` { sentType, sentDate, remark } and `POST /api/vehicles/:id/inspection-sent/cancel` { remark } (while the result is pending); `PATCH /api/vehicles/document-submission/:id/receipt-fields` { plateCategory?, plateNumber?, receiptNo?, receiptAmount?, receiptDate?, receiptReceivedDate?, remark } -> { submission, liveSlips, liveInvoices } (RECEIPT_RECEIVED only, status never reopened, user 2026-09-27; the old receipt-date route remains but the UI uses this one); `PATCH /api/{plate,book}-photos/vehicle/:vehicleId/received-date` { date, remark } and `POST /api/{plate,book}-photos/vehicle/:vehicleId/detach` { remark } -> { vehicleId, chassis, photo: deleted|shared|none } (ADMIN / STAFF_CAR / STAFF_MOTO, only before that item was delivered, user 2026-09-27; detach frees the photo hash).
  - Plate arriving after the book was delivered (user 2026-09-27): plate attach returns `alreadyDelivered`, `bookSlipNo`, `bookDeliveredDate` and the page explains both paths. `POST /api/delivery/slips/:id/add-plate` { vehicleId, remark? } = "ป้ายไปพร้อมเล่มแล้ว": ticks the plate on the original book slip, sets plateDeliveredDate = slip date, moves a later plateReceivedDate back to the slip date, allowed for billed vehicles. The report's ป้ายค้างส่ง list comes from `GET /api/delivery/plate-pending`, and book-only items show `plateSentLater` (DL number and date of the later plate slip).
  - Lists no longer cut silently: receiving `completed?kind&q&offset&limit` -> { vehicles, hasMore } (newest attach first; `pending?kind`); `GET /api/vehicles/document-submission?kind&q&offset` -> { submissions, hasMore } and `GET .../document-submission/dates` -> { dates: [{ date, count }] } for the records page; inspection completed = every unsubmitted result + the latest 100 submitted; `GET /api/billing/invoices?offset&limit` -> { invoices (all ISSUED + history pages), hasMore, outstanding }; `GET /api/delivery/slips` -> { slips, truncated }; `GET /api/receipts/unassigned?offset&limit` -> { receipts, total, hasMore }.
  - Removed unused routes: `PATCH /api/vehicles/:id/receiving/:step`, `PATCH /api/vehicles/document-submission/:id/status`, `PATCH /api/vehicles/:id/tax-input`, `POST /api/vehicles/:id/document-submission` and `/preview`. Use `fetchAuthedBlob` (lib/api.ts, 401 -> login) for any protected file.
  - Data rules: chassis stored upper-case without spaces with case-insensitive duplicate checks (a DB index on upper(chassis) still needs a migration); brand and finance names are de-duplicated ignoring case; a required CC/weight must be > 0 and 0 counts as missing for tax; tax renewal keeps the รย.1 hire-purchase exemption (owner read from the linked VehicleOwner at every recompute and kept in `taxBreakdown.owner`; manual entries have a `financed` checkbox); VOID invoices reprint with a ยกเลิก watermark; the Step 4 owner type only fills a missing owner, never replaces one.
  - Wave 2 (user decisions 2026-09-27, migration `20260927120000_audit_log_and_cancel`, purely additive): `AuditLog` (entity, entityId, action, remark, changes JSON, editedById) records every edit/cancel of non-vehicle records (Customer, Invoice, TaxRenewal, YamahaRelocation, PlateSwap, User); write it with `writeAudit` / `requireRemark` / `diffChanges` in `backend/src/audit/audit-log.ts` inside the same transaction. Vehicle-level changes stay in VehicleEditLog. Soft cancel only: `TaxRenewal`, `YamahaRelocationEntry` and `PlateSwap` have `cancelledAt/cancelReason/cancelledById` and every read filters `cancelledAt: null`.
  - Transfer notice fix: `PATCH /api/vehicles/:id/transfer-notice/correct` { done, completedDate, cost, remark, expectedCompletedDate?, expectedCost? } ("✎ แก้" in the completed table, now searchable and paged `?q&offset&limit` -> { vehicles, hasMore }); undo only before the inspection is sent, date/cost until submitted. The plain transfer-notice PATCH refuses vehicles already done.
  - Editing a vehicle after a step used its data warns and never recalculates: `PATCH /api/vehicles/:id` answers 409 { needsConfirm, affected[{ step, label, fields, note, confirmKey, repriceable }], taxPreview? } until resent with `confirm: true, confirmedSteps` (rules in `backend/src/vehicles/vehicle-edit-impact.ts`); a PENDING submission is fixed by cancel + resubmit.
  - Step 4 date and plate swap: the step-1 queue, search and paste lookup load for the flow's submit date (`SubmitDateField`), so a cancelled/FAILED car can be resubmitted with its original date within 90 days of the pass. The new car of a plate swap takes the OLD car's plate. New plate options `SWAP_NORMAL` / `SWAP_AUCTION` ("มีคนทำสลับเลขมาให้", cars only): plate required, no ขอใช้เลข fee, normal plate fee, not an extra request. One open-swap rule (returnedDate null and cancelledAt null) in `document-submission/plate-swap-link.ts` blocks Step 4 and linking; linking a car that is already submitted or already the new car of another open swap is refused. Swap rows carry `linkedPlateIsNewPlate` to flag cars prefilled the wrong way before this fix.
  - Correcting other jobs (owner staff + ADMIN, reason required): tax renewal `PATCH /api/tax-renewals/:id` (corrections need remark) and `POST .../:id/cancel`; Yamaha `PATCH /api/yamaha-relocation/:id` and `POST .../:id/cancel` (frees the attachments' hashes); plate swap `PATCH /api/plate-swaps/:id`, `POST .../:id/undo-return`, `POST .../:id/cancel` (DELETE removed). Forms send what they loaded (expectedUpdatedAt etc.) and get 409 when stale.
  - Billing (ADMIN + ACCOUNTANT, AuditLog 'Invoice'): `PATCH /api/billing/invoices/:id/unpay` { remark } (PAID -> ISSUED); `PATCH /api/billing/invoices/:id` edits an ISSUED invoice in place keeping its number (lines, extras, issue date, remove vehicles, `refreshLineIds` pulls current vehicle data, `applyCurrentTerms`); history at `GET .../invoices/:id/history`. "ปิดงาน - วางบิลนอกระบบ": `POST /api/billing/vehicles/:id/close` { note } (ADMIN/ACCOUNTANT) and `POST .../reopen` { remark } (ADMIN) set/clear `Vehicle.billingClosed*`; closed vehicles leave the billing queue, the overview receivables and the /vehicles billing wait (list: `GET /api/billing/vehicles/closed`).
  - Admin: `PATCH /api/admin/users/:id/password` { password, confirmPassword, remark } sets a temporary password for another user (the user changes it in เปลี่ยนรหัสผ่าน); `npm run seed:admin` no longer promotes an existing non-admin. `PATCH /api/customers/:id` { 7 fields, remark, terms?, expectedUpdatedAt } (ADMIN) with history at `GET /api/customers/:id/history`; issued invoices keep their customer snapshot.
  - Delivery: one slip = one customer and one vehicle kind (400 'ส่งรถยนต์กับจักรยานยนต์คนละใบ'); old mixed slips carry `hiddenItems` for single-kind staff. ใบยื่น/lot key = submit date + job-sheet group + customerId on every page (`jobSheetKey` / `customerDisplayNames` in `lib/job-sheet.ts`).
  - Executive overview: a submission's Bill value is the receipt amount once RECEIPT_RECEIVED, else the computed Bill + tax; jobs keyed with a future submit date are shown apart (`workingCapital.advance`) and not counted as paid. The money basis of เงินจม is still undecided (user may redesign the page).
- Collection accounts (user 2026-09-26/27): money goes into the company account (VAT) or a personal account (e.g. SPI,
  YMAC; no VAT). One account per customer, but it can move later (the user splits accounts to spread the tax base), so
  `CustomerAccountPeriod` keeps the history with a start date: a job belongs to the account in effect on its date
  (`accountOn` in `backend/src/billing/billing-account.ts`; no rows = company). Set on the billing page ("บัญชีรับเงิน",
  `GET/POST /api/billing/customers/:id/account` `{ account, effectiveFrom, remark }`, remark mandatory, AuditLog
  `set-account`). The billing queue returns `account` per customer and per vehicle (by delivered date). `Invoice.account`
  = the account of its vehicles (one bill may not mix accounts). Personal-account bills never have VAT (WHT still per
  customer), number in their own series (`suggestedPersonalInvoiceNo`), and print the personal issuer (name as on the
  bank account, no tax ID, no address yet) with its bank account: `PERSONAL_PROFILE` in `frontend/src/lib/company-profile.ts`.
  `ServiceFeeRate.includesReceipt` (user 2026-09-27, YMAC): the price already includes the DLT receipt, so the service
  fee = price − that vehicle's actual receipt (`serviceFeeFromRate`; the billing page recalculates when the receipt is
  edited). YMAC prices (all-in): new motorcycle 650 (receipt 340), 300cc 1,200 (not used yet), tax renewal 150 (100),
  transfer 800 (105/130), transfer with fine 1,000 (305/330) - transfer and tax renewal are not billable in the system yet.
  Auto price matching (user 2026-09-28, "fewest mistakes"): `ServiceFeeRate.kind` = `BASE` (one per vehicle, chosen by
  vehicle kind/CC) or an add-on `OTHER_PROVINCE` (ขอใช้) / `URGENT`, added automatically when the vehicle is registered in
  another province than the owner's / its latest submission was urgent (`suggestAddOns`; queue rows carry `urgent`, `otherProvince`, `suggestedRateId`,
  `suggestedAddOnIds`). The billing page shows a rate dropdown + add-on checkboxes per vehicle and computes the fee
  (typing a fee only via "กำหนดเอง"), flags rows changed from the system's choice or with no matching rate, and shows a
  per-price breakdown before issuing. "ขอใช้" here = ขอใช้จังหวัดอื่น (registrationProvince ≠ ownerProvince, the same rule
  as the ธรรมเนียมอื่นๆ 20 fee), kind `OTHER_PROVINCE` - not a plate-number request; it will apply to cars too.
  `ServiceFeeRate.chassisPrefix` (user 2026-09-28, MC Superbike: chassis starting ML = 885, JH = 2685, both fall in the
  same 300-799cc bracket so CC alone can't tell them apart) - an optional prefix a BASE row's vehicle must match
  (case-insensitive `chassis.startsWith`), checked in `suggestRate` alongside vehicleKind/CC; null = unrestricted, same
  as before. Rate editor has an "เลขตัวถังขึ้นต้น" column.
  Rate kind `PLATE_REQUEST` (user 2026-09-28, Spac EV: "ขอใช้เลข" priced separately from "ขอใช้" the province) = the
  vehicle's latest submission requested a plate number (`requestsPlateNumber`) - distinct from the pre-existing
  "ลูกค้าชำระค่าขอใช้เลขเอง" deduction checkbox on the billing row, which subtracts from an already-computed fee rather
  than suggesting one.
  Rate kind `TRANSFER_NOTICE` (user 2026-09-28, Spac EV: "แจ้งย้าย" 182.24, only for vehicles that actually go through
  แจ้งย้าย, not every vehicle) = `registrationProvince !== 'กรุงเทพมหานคร'` (`transferNotice` in `billing.service.ts`,
  same rule as `getTransferStatus` in `vehicles.service.ts`) - a different comparison from `OTHER_PROVINCE`
  (`registrationProvince !== ownerProvince`); the two are independent and can both apply to the same vehicle.
  Tick-only billing (user 2026-09-28): the queue is a compact list per delivery date (plate, chassis, "ใบเสร็จ x +
  ค่าบริการ y", tags), no sideways scrolling; details (receipt, rate, add-ons, bill text, ปิดงาน) sit behind "แก้"; cars
  with a problem (no receipt amount / no price) are flagged and cannot be ticked; a sticky bottom bar shows count + total
  and "ออกบิล" opens a confirm dialog (invoice no., date, job label, breakdown, extras, totals, preview). Receipt check
  (user 2026-09-28): queue rows carry `receiptEstimate` (Bill fees + tax computed at submission from the vehicle data); a
  receipt amount that differs is a blocking "ต้องตรวจ" with a hint (+ = maybe ขอใช้ though the data says no, − = the
  reverse) until the accountant ticks "ตรวจกับใบเสร็จจริงแล้ว" in "แก้" (found 2 real TWE cars with the wrong province).
  `receiptEstimate` is recomputed from the vehicle's current data + the submission's options (`currentBillEstimate`), so
  fixing the province clears the warning; "แก้" also shows the receipt photo(s) and an "แก้ข้อมูลรถ" link (ADMIN /
  STAFF_ENTRY) to `/registration/new-vehicle/entry?focus=<chassis>&edit=1&returnTo=/accounting/billing` (same tab),
  which opens that car's edit form and, after a successful save, returns to billing (`returnTo` only accepts the billing
  page); the ticked cars and the open "แก้" panel are restored from sessionStorage (`billing-return-v1`). The same check runs earlier: step 5 (รับใบเสร็จ) explains a "ไม่ตรง Bill"
  (maybe ขอใช้), links to the vehicle edit and asks for confirmation before saving; step 4 settings tag ขอใช้ cars. Company-account prices are always on top of the receipt (user); TWE: <300cc 520,
  300-799cc 885, ขอใช้ +100, ด่วน +100 (taken as before VAT).
- Custom invoices and per-bill WHT (user 2026-09-29): `/accounting/billing/custom` issues a bill with free-typed lines and
  no vehicles (old jobs moved from the previous system, goods sales such as selling a company car). `InvoiceItem` (kind,
  description, quantity, unitPrice, amount = quantity x unitPrice computed by the server, cost per unit, sortOrder) with
  kinds `FEE` (no VAT, no WHT), `SERVICE` (VAT + WHT), `GOODS` (VAT, no WHT); `Invoice.goodsTotal` holds the goods sum,
  VAT = (service + goods) x rate, WHT = service x rate. `cost` is internal (never printed, null = unknown, always null
  for FEE); profit = (unitPrice - cost) x quantity per line. The same lines can also go on a vehicle bill (`items` on
  `POST /api/billing/invoices`; the billing page's confirm dialog and the edit dialog use the shared
  `components/InvoiceItemsEditor.tsx`, which replaced the old "ค่าใช้จ่ายอื่นๆ" box for new bills; old bills keep their
  `extras`). On a mixed bill the vehicle fee line and the attachment total count vehicles only, and the attachment notes
  the other lines. API: `POST /api/billing/custom-invoices` { customerId, invoiceNo, issueDate, jobLabel, items, whtRate? }, `GET
  /api/billing/next-invoice-no`, `GET /api/billing/invoices/:id`; `PATCH /api/billing/invoices/:id` also takes `items`
  (full replace) and `whtRate`. The bill's account = the customer's account on the issue date; numbering shares the
  vehicle bills' series. A bill without vehicles prints one page (no attachment); "แก้ไขบิล" on such a bill opens the
  custom page with `?edit=<id>`. Every bill (vehicle, custom, and edits) can override the WHT rate
  (`components/WhtRatePicker.tsx`: ตามลูกค้า / 1% / 3% / ไม่หัก / อัตราอื่น); a rate different from the customer's
  (or, when editing, the bill's own) must be ticked as checked before saving. Invoices print "ค่าบริการ" instead of
  "ค่าดำเนินการ" (reprints of old bills too).
- Tax invoices + 50 ทวิ + credit terms (user 2026-09-28, migration `20260929120000_tax_invoices`, code in
  `backend/src/billing/tax-invoice.*`, page `/accounting/tax-invoices` + `/wht`): a ใบกำกับภาษี/ใบเสร็จรับเงิน (`TaxInvoice`)
  is issued when the money comes in, only for COMPANY-account bills with VAT, 1 bill = 1 active TV (partial unique index
  `TaxInvoice_invoice_active_key`). Number `TV{year}-{3 digits}` from `TaxInvoiceSeries` (row-locked, date = paid date, a
  date before the year's latest TV is refused); no series row = not enabled yet (old "รับเงินแล้ว" + typed TV no. still
  works); ADMIN enables it by setting the last Google-Sheet number (`POST /api/billing/tax-invoices/series/set`
  `{ year, lastNumber, remark }`, only while that year has no system TV). Once enabled, `PATCH .../invoices/:id/paid`
  refuses COMPANY+VAT bills and `unpay` refuses bills with a system TV. Issue: `POST /api/billing/invoices/:id/tax-invoice`
  `{ paidDate, whtAmount (actual, may differ from the bill), whtMethod NONE|PAPER|EWHT, buyerNotVatRegistered?,
  expectedUpdatedAt? }` (preview `GET .../invoices/:id/tax-invoice-preview`); buyer name + address + 13-digit tax ID
  required (tax ID optional when not VAT registered), snapshot of the live customer. Never edited: cancel
  (`POST /api/billing/tax-invoices/:id/cancel { remark }`, number kept as CANCELLED, bill back to ISSUED, AuditLog
  'Invoice') then reissue (new TV refers to it via `replacesId` and takes over its 50 ทวิ); lost original = ใบแทน
  (`.../:id/replacement { remark }`, same number). Print (`lib/tax-invoice-print.ts`, same CSS as the invoice): original
  + copy on the day it was issued, copy only afterwards; per-vehicle detail is not reprinted, it refers to the bill's
  attachment `IV…-A`; one signature box ผู้รับเงิน. `GET /api/billing/tax-invoices?month=YYYY-MM` (incl. cancelled) feeds
  the list and the sales-tax Excel. 50 ทวิ (`WhtCertificate`): one certificate may cover several TVs of one customer;
  PAPER needs a file, EWHT a reference; `POST /api/billing/wht-certificates` (multipart `file`, `method`,
  `certificateNo`, `certificateDate`, `amount`, `note`, `taxInvoiceIds` comma list), cancel frees the hash;
  `GET /api/billing/wht-pending` (overdue after 30 days, user) + `POST .../wht-pending/remind`. Credit terms:
  `Customer.billingCreditDays` (terms editor, `creditDays` in `PATCH .../customers/:id/terms`), `Invoice.dueDate` =
  issue date + days at issue (shifted when the issue date is edited); the invoice list flags overdue / due in 7 days.
- Quotations (ใบเสนอราคา, user 2026-10-01, migration `20261001090000_quotations`, code in
  `backend/src/billing/quotation.*`, pages `/accounting/quotations` (list), `/new` (`?edit=<id>` = edit a draft),
  `/view?id=`): YM's work must be quoted and approved (YM sends back a PO as a PDF with a number) before every bill, and
  the same flow works for any customer. `Quotation.kind`: `JOB` = an amount for a job (lines like `InvoiceItem`), `RATE` =
  per-vehicle prices (lines carry the `ServiceFeeRate` fields). Status `DRAFT` (no number, freely edited or deleted) ->
  Custom tax invoice (user 2026-10-05, migration `20261005160000_custom_tax_invoice`): a TV for work outside the system, with no
  ใบวางบิล. `TaxInvoice.invoiceId` is nullable and the typed lines live in `TaxInvoiceItem` (kind FEE | SERVICE | GOODS,
  quantity x unitPrice, no cost). Same number series, date-order rule, WHT method and cancel / ใบแทน as the bill-based TV; VAT
  is always 7% (FEE lines have none), COMPANY-account customers only, buyer data from the customer row (same missing-field
  check); `billingRequiresQuotation` does not apply here (user 2026-10-06: the quote already covers it). The WHT
  amount is typed (suggested from the customer's rate). Cancelling one touches no bill and logs to AuditLog entity
  'TaxInvoice'; "ออกใหม่แทน" = `replacesId` (cancelled custom TV only, one replacement, 50 ทวิ carried if same customer).
  API: `GET /api/billing/tax-invoices/custom-preview?customerId&date` (buyer, missing, nextNo, account, whtRate) and
  `POST /api/billing/tax-invoices/custom` { customerId, issueDate (= paid date), items, whtAmount, whtMethod,
  buyerNotVatRegistered?, replacesId? }; TaxInvoice reads now return `invoiceNo` / `invoiceId` null for these. Page
  `/accounting/tax-invoices/new` (`?replaces=<id>`), button on `/accounting/tax-invoices`; `InvoiceItemsEditor` has `hideCost`.
  `ISSUED` -> `APPROVED` | `REJECTED`, plus `CANCELLED` and `SUPERSEDED`; the screen groups by `stage` (`stageOf`:
  WAITING / EXPIRED by `validUntil`, DONE once billed or applied as rates). Number `QT{year}-{3 digits}` from
  `QuotationSeries` (one series for both accounts, row-locked, created on first use), given at issue; an issued
  quotation is never edited: "ทำฉบับแก้ไข" makes a draft (`replacesId`) that takes the same number + `-R1` when issued
  and supersedes the old one. Validity defaults to 30 days. A customer not in the system yet can be typed in
  (`customerId` null) and linked later (`link-customer`), required before billing / applying rates. Approval needs the
  date plus a PO number or a file (PDF/image, stored under `quotations/`, hash-checked). After approval: `JOB` ->
  "ออกใบวางบิลจากใบนี้" creates a custom invoice with the lines copied unchanged (`Invoice.quotationId/quotationNo/poNumber`,
  printed on the bill; one live bill per quotation via partial unique index `Invoice_quotation_active_key`; voiding the
  bill lets it be billed again); `RATE` -> "ตั้งเป็นราคาลูกค้า" replaces the customer's `ServiceFeeRate` table (old rows
  go to the customer's AuditLog). `Customer.billingRequiresQuotation` (checkbox in the terms editor,
  `requiresQuotation` in the terms API): such a customer can only be billed from an approved quotation
  (`QUOTATION_REQUIRED_ERROR` in `createInvoice` / `createCustomInvoice`), so vehicle bills are blocked for them.
  Yamaha (small and large go to different departments, so they are separate quotations, user 2026-10-05): "ดึงยอดรถเล็ก" /
  "ดึงยอดรถใหญ่" fills the lines of that size from the month's relocation counts (`yamahaQuoteItems(month, counts, size)`:
  small = ค่าธรรมเนียมแจ้งย้าย (เล็ก) ประจำเดือน <Thai month, CE year> 5/vehicle, ค่าบริการแจ้งย้าย (เล็ก) 20/21/22 by work
  month, ค่าบริการจัดการเอกสารบัญชี 9,000; large = ค่าธรรมเนียม (ใหญ่) 5/vehicle + ค่าบริการ (ใหญ่) 50/vehicle) and stores
  `yamahaMonth` + `yamahaSize` (SMALL | LARGE, null on older quotations that cover both) + `yamahaCounts`; issuing
  re-checks only its own size's count and allows one live quotation per month and size (an old null-size one counts for
  both), and while one is ISSUED/APPROVED that size's `YamahaRelocationEntry` rows cannot be added, edited or cancelled
  (`assertYamahaMonthNotQuoted(db, [{ date, size }])`; fix = cancel the quotation first). The custom-invoice page pulls the
  same month counts per size (`frontend/src/lib/yamaha-billing.ts`; keep its names and prices in step with
  `quotation-calc.ts`). API under `/api/billing/quotations` (ADMIN + ACCOUNTANT): `GET ?stage&q&offset` -> { quotations,
  hasMore, counts }, `GET /yamaha-month?month=&size=SMALL|LARGE`, `GET /ready?customerId=`, `POST`, `GET/PATCH/DELETE /:id` (PATCH/DELETE drafts only), `POST
  /:id/issue`, `/approve` (multipart `approvedDate`, `poNumber`, `file`), `/unapprove`, `/reject`, `/cancel` (these three
  need `remark`), `/revise`, `/link-customer`, `/invoice` { invoiceNo, issueDate }, `/apply-rates`, `GET /:id/po-file`,
  `GET /:id/history` (AuditLog entity `Quotation`). Print: `frontend/src/lib/quotation-print.ts` (same CSS as the
  invoice; total before WHT, WHT as a note; draft / cancelled watermark).
- Vehicle use cancellation (ยกเลิกการใช้รถ, user 2026-10-02, migration `20261002100000_vehicle_use_cancellation`, code in
  `backend/src/vehicle-use-cancellation/`, pages `/registration/other/cancel-use/{car,moto}/{submit,return}`): first subtask of
  "อื่นๆ". One `VehicleUseCancellation` row per vehicle, filled like a plate swap without the new plate (job owner =
  `customerId`, owner name, engine, chassis, brand from `Brand`, plate หมวด + เลข, submit date). Fixed fees chosen by the
  user, snapshotted at submit and never taken from the client: Bill 25, No Bill 100, ค่าอากร 10 kept apart (not inside No
  Bill, not in the total, unlike plate swap); constants in `vehicle-use-cancellation-fee.ts` (copied in
  `frontend/src/lib/vehicle-use-cancel-fee.ts`). Second step = receive receipt like plate swap: `ReceiptImage.vehicleUseCancellationId`,
  OCR fills receiptNo/date/amount, at least one photo + return date (not after today) to confirm. Edit/cancel/undo-return/
  receipt changes after return need a remark and go to `AuditLog` entity `VehicleUseCancellation`; cancel is soft
  (`cancelledAt`). API `/api/vehicle-use-cancellations` (`GET ?status&month&vehicleClass`, `POST`, `PATCH /:id`, `PATCH /:id/return`,
  `POST /:id/undo-return`, `POST /:id/cancel`, `POST/DELETE /:id/receipts`, `PATCH /:id/receipt-fields`); access = `ADMIN` / `STAFF_CAR`
  (cars) / `STAFF_MOTO` (motorcycles) write, `ACCOUNTANT` read. Not built (user did not ask): receive plate/book, Delivery,
  billing, executive overview.
- Plate copy (คัดแผ่นป้ายทะเบียน, user 2026-10-02, migration `20261002160000_plate_copy`, code in `backend/src/plate-copy/`, pages
  `/registration/other/plate-copy/{submit,return,receive-plate}`): second subtask of "อื่นๆ", built like vehicle use cancellation
  (same fields: job owner, owner name, engine, chassis, brand, plate หมวด + เลข, submit date; receipt step with OCR) but cars only
  (`vehicleClass` is always CAR, MOTO is refused; STAFF_CAR / ADMIN write, ACCOUNTANT read) and with a third step, receive
  plate. Fixed fees snapshotted at submit: Bill 205, No Bill 100, ค่าอากร 10 kept apart (not in No Bill, not in the total);
  constants in `plate-copy-fee.ts` (copied in `frontend/src/lib/plate-copy-fee.ts`). Receive plate = a card per job with a
  camera / gallery photo of the plate, the received date (not before the submit date, not after today) and a confirm
  button; the photo is required, stored in `PlatePhoto` (hash-checked, `PlateCopy.platePhotoId` + `plateReceivedDate`), no AI,
  not tied to the receipt step. The usual wait is 15 days, so the card shows the expected date (submit + 15) and an overdue
  warning (`PLATE_COPY_EXPECTED_DAYS`; information only). Correcting the date / detaching the photo needs a remark and goes to
  `AuditLog` entity `PlateCopy`, like edit / cancel / undo-return / receipt changes after return; cancel is soft and frees
  the receipt and plate photo hashes. Receipts use `ReceiptImage.plateCopyId` (the old receipts guards skip these rows).
  API `/api/plate-copies` (`GET ?status&month`, `POST`, `PATCH /:id`, `PATCH /:id/return`, `POST /:id/undo-return`,
  `POST /:id/cancel`, `POST/DELETE /:id/receipts`, `PATCH /:id/receipt-fields`, `GET /plate-queue?status`,
  `POST /:id/plate-photo` (multipart `file`, `date`), `PATCH /:id/plate-photo/date`, `POST /:id/plate-photo/detach`,
  `GET /:id/plate-photo/image`). Not built (user did not ask): Delivery, billing, executive overview, motorcycles.
- Vehicle transfer (งานโอน, user 2026-10-02, migration `20261002180000_vehicle_transfer`, code in `backend/src/vehicle-transfer/`, pages
  `/registration/transfer/{owner,inspection}/{submit,inspect,return}`): replaces the empty placeholder and supersedes the older
  "reuse Vehicle + job intake pool" plan. Built like vehicle use cancellation (own table `VehicleTransfer`, vehicle keyed in by hand: job
  owner, chassis, engine, brand, plate หมวด + เลข, submit date) but cars and motorcycles share one page (`vehicleClass` is a form field,
  prices differ) and every job has `transferorName` (ผู้ถือกรรมสิทธิ์ผู้โอน) + `transfereeName` (ผู้รับโอน). `transferType`: `OWNER` (โอนตามผู้ถือกรรมสิทธิ์,
  no inspection: ยื่น -> รับใบเสร็จ) or `INSPECTION` (โอนตรวจรถ: ยื่น -> ส่งตรวจ -> ผลตรวจ -> รับใบเสร็จ). The inspection is its own columns
  (`inspectionSentDate`, `inspectionResult` PASS|FAIL, `inspectionResultDate`), NOT the new-registration inspection queue (user: "ไม่ได้รวมไปกับการตรวจแบบที่ 1");
  receipts can be attached and returned only after PASS, a FAIL is cleared with `inspection-undo` (mandatory remark) and re-recorded.
  Fees (user 2026-10-02, `vehicle-transfer-fee.ts`, copied in `frontend/src/lib/vehicle-transfer-fee.ts`): same for both types.
  Motorcycles: The form picks โอนปกติ / โอนขอใช้ (`useRequest`) + งานด่วน (`urgent`) + ค่าปรับ (`fineAmount`, typed by the clerk, applies to both when
  more than 15 days after the receipt / tax invoice was issued). Bill: normal = คำขอ 5 + โอนทะเบียนรถ 100; ขอใช้ = คำขอ 10 + โอนทะเบียนรถ 100 + ค่าธรรมเนียมอื่นๆ 20;
  fine added. No Bill: ลงขัน 60 + ลงขันด่วนเพิ่ม 50. ค่าอากร (normal 20 / ขอใช้ 40, automatic from the chosen type; changed from 10/30 on 2026-10-02) is kept apart like
  vehicle use cancellation (user 2026-10-02: "แยกค่าอากรออกมา"): NOT inside `noBillTotal`, NOT in the total, stored in `dutyAmount` and shown on its own line. The backend computes and
  snapshots `billTotal` / `noBillTotal` / `dutyAmount` itself (client totals ignored for MOTO); an edit that does not touch class / ขอใช้ / ด่วน / fine keeps
  the old snapshot. Cars: No Bill = ลงขัน 100 (+ ลงขันด่วนเพิ่ม 100 when `urgent`), no duty (user gave only No Bill; the label "ลงขัน" is Claude's choice);
  Bill has no rate yet so the clerk types `billTotal` (required, 0 allowed); ขอใช้ and fine are refused for cars. Client No Bill amounts are ignored for both classes.
  Edits to any amount need a remark (AuditLog).
  Receipts use `ReceiptImage.vehicleTransferId` (OCR + hash check like the other jobs, old receipts guards skip them). Edit / cancel /
  undo-return / receipt changes after return need a remark and go to `AuditLog` entity `VehicleTransfer`; cancel is soft. API
  `/api/vehicle-transfers` (`GET ?status=all|pending|returned|to-send|to-result|inspected&month&transferType&vehicleClass`, `POST`, `PATCH /:id`,
  `PATCH /:id/inspection-sent`, `PATCH /:id/inspection-result`, `POST /:id/inspection-undo`, `PATCH /:id/return`, `POST /:id/undo-return`,
  `POST /:id/cancel`, `POST/DELETE /:id/receipts`, `PATCH /:id/receipt-fields`); access = `ADMIN` / `STAFF_CAR` (cars) / `STAFF_MOTO` (motorcycles)
  write, `ACCOUNTANT` read. Not built (user did not ask): vehicle photos for the inspection, receive plate/book, Delivery, billing, executive overview.
- HR / payroll (ฝ่ายบุคคล + เงินเดือน, user 2026-10-05, migration `20261005140000_hr_payroll`, code in `backend/src/hr/`, pages `/hr/employees`,
  `/hr/payroll`, `/hr/payroll/view?id=`): **ADMIN only, reads included** (`/api/hr` rule in `access-policy.ts`, `/hr` in `PAGE_RULES`; without the
  rule the catch-all GET rule would let every staff role read salaries). First round = employee register + monthly salary only (user's choice:
  no leave/attendance/OT, no documents, no loans). `Employee` is its own table (not `User`): code (TI001), prefix, first/last name, position,
  `idType` CITIZEN (13 digits) | OTHER (foreign workers, e.g. an 11-digit number), `idNumber` unique, birthDate, startDate, `baseSalary`,
  `socialSecurity` (per person, some are not enrolled), `withholdTax`, `otherAllowance` (yearly deductions beyond the personal 60,000),
  status ACTIVE | RESIGNED + `resignedDate`, optional `userId` link. Never deleted; edits need a remark and go to `AuditLog` entity `Employee`
  (salary changes included). Personal data is never seeded in the repo: the register has a paste-from-Excel import (`lib/hr-api.ts`
  `parseEmployeePaste`, columns: code, prefix, name, position, id number, (unused), birth date D/M/พ.ศ., salary, social security; blank or "-" =
  not enrolled), all-or-nothing, existing code / id number skipped. `PayrollRun` (`month` YYYY-MM, status DRAFT -> APPROVED -> PAID, soft cancel,
  one live run per month by partial unique index `PayrollRun_month_active_key`, `ssoRate` / `ssoWageCap` snapshot) with `PayrollItem` per person
  (snapshot of code / name / position; salary, otherIncome, otherDeduction, ssoAmount, taxAmount, netPay computed by the server; `ssoManual` /
  `taxManual` = typed over). Rules in `payroll-calc.ts` (Claude's reading of the law, check before the rules change): SSO 5% of salary, wage base
  floor 1,650, cap by year 15,000 (before 2026) / 17,500 (2026-2028, confirmed by the user's real sheet: 25,000 -> 875) / 20,000 (2029-2031) /
  23,000 (2032+); withholding (ภ.ง.ด.1) = projected-annual method: monthly income x 12 - expense 50% (max 100,000) - personal 60,000 - SSO (max
  9,000) - `otherAllowance`, progressive brackets, / 12 (a bonus month is only an estimate, the line is editable). Only DRAFT is editable
  (row-locked via a conditional `updateMany` on the run); unapprove / unpay / cancel / recalculate need a remark or confirmation and are logged to
  `AuditLog` entity `PayrollRun`; a PAID run must be un-paid before it can be cancelled; pay date <= today. Employees included in a run: ACTIVE
  plus those resigned on/after the first of that month; no proration (edit the line). API `/api/hr`: `GET/POST employees`, `POST employees/import`
  { rows }, `PATCH employees/:id` { fields, remark, expectedUpdatedAt }, `POST employees/:id/resign` { date, remark } / `reinstate` { remark },
  `GET employees/:id/history`; `GET/POST payroll/runs` { month }, `GET payroll/runs/:id` (items + totals incl. `ssoRemit` = employee + employer
  share for สปส.1-10 and `tax` for ภ.ง.ด.1), `PATCH payroll/runs/:id/items/:itemId` { salary, otherIncome(+Note), otherDeduction(+Note), sso, tax
  (number = override, null = auto) }, `POST .../recalculate | approve | pay { payDate } | unapprove | unpay | cancel { remark }`, `GET .../history`.
  SSO schedule checked against the official announcement 2026-10-05 (5%; cap 17,500 from 2569, 20,000 from 2572, 23,000 from 2575). Payslips print from the run page (`lib/payslip-print.ts`, 2 per A4, all dates in พ.ศ., also "save as PDF") and carry year-to-date income / SSO / tax (`items[].ytd` on `GET payroll/runs/:id`: earlier non-cancelled runs of the same year + this one), CSV download of the run. Not built (user did not ask):
  bank account / transfer file, leave and attendance, bonus tax special case, year-end 50 ทวิ for employees, ภ.ง.ด.1 / สปส.1-10 forms, linking
  salaries to the cash ledger.
- Customer payments (user 2026-09-27): SPI decides itself what it pays per vehicle and its pricing is still being
  negotiated, so `/accounting/customer-payments` records what the customer actually paid (`CustomerPayment`: paid date,
  transferred amount, WHT, reference, account snapshot; `CustomerPaymentLine` per chassis as the customer listed it,
  `vehicleId` null when not found) and shows a mirror table of delivered vehicles with the amount paid per vehicle. Lines
  are pasted from Excel (chassis then amount per row). Not linked to `Invoice`. Cancel is soft with a mandatory reason
  (AuditLog entity `CustomerPayment`). API `/api/customer-payments` (`GET ?customerId&offset`, `GET /vehicles?customerId&
  from&to&status=paid|unpaid`, `POST /match`, `POST`, `POST /:id/cancel`), access ADMIN / ACCOUNTANT / STAFF_CAR
  (STAFF_CAR matches and sees cars only). Accounting flow decided with the user but not built yet:
  Yamaha monthly bill to YM (company account, small 20 → 21 from 2027-01-01 → 22 from 2028-01-01, large 50, + 9,000),
  cross-account netting, staff cash advance with a 100-baht shortage tolerance, subcontractor WHT (ภ.ง.ด.3/53), payroll.
- Owner names at vehicle entry: without finance the form requires `ชื่อผู้ถือกรรมสิทธิ์` (stored in `VehicleOwner.name`); with finance the registered owner is the finance company name (read-only) and the form requires `ชื่อผู้ครอบครอง` (stored in `VehicleOwner.hirerName`).

## Login, roles, and customer portal (added 2026-09-22, branch feature/login)

- Roles (user-decided): `ADMIN` (everything + approve users), `STAFF_ENTRY` (steps 1-3: vehicle entry, transfer notice, inspection, plus brands/finance/owner reference data; all vehicle types), `STAFF_CAR` and `STAFF_MOTO` (steps 4-8: submit documents, receipt, plate, book, Delivery, job sheet; only cars / only motorcycles, where motorcycle = `Vehicle.body` starting with `รย.12-`; holding both = all vehicles; they can read steps 1-3 but not save, except that `STAFF_MOTO` can also save step 2 แจ้งย้าย/ตัดบัญชี for motorcycles, added 2026-09-24: `canEditTransferNotice` in `vehicle-scope.ts` and `auth.ts`), `ACCOUNTANT` (billing + dashboard + read-only on registration data; step 8 only through the delivery report and slips, read-only, user 2026-09-27), `DELIVERY` (Delivery page only, no prices), `CUSTOMER` (portal only). Staff roles have no dashboard `/` and cannot add customers (only `ADMIN` can `POST /api/customers`; the add form is hidden for others). One user may hold several staff roles (`User.roles[]`); `CUSTOMER` cannot be combined with staff roles.
- Vehicle-type scoping for steps 4-8 is enforced in `backend/src/auth/vehicle-scope.ts` (a Prisma `where` fragment plus `assertVehicleInScope`) inside the step 4-8 services; the current user reaches services through AsyncLocalStorage (`backend/src/auth/request-context.ts`, opened per request in `main.ts`). Outside an HTTP request (unit tests, scripts) the scope is unrestricted. Read vs write scope (2026-09-27): `vehicleScopeFor` = what a user sees, `writeScopeFor` = what they may change, so STAFF_CAR / STAFF_MOTO holding ACCOUNTANT or DELIVERY too still change only their own kind (`assertVehicleInScope` / `assertKindInScope` use the write scope, `assertVehicleReadable` the read scope); DELIVERY still delivers every kind (`currentDeliveryScope`). The frontend mirrors them in `frontend/src/lib/auth.ts` (`vehicleScopeFor`, `writeScopeFor`, `submitWriteScopeFor`, `canEditSubmitSteps`).
- Flow: anyone registers at `/register` (staff tab: name, nickname, email, phone, password x2, requested role; customer tab: contact name, company, phone, email, password x2; no ID-card number) -> status `PENDING` -> Admin approves at `/admin/users`, sets roles and, for customers, links `User.customerId` to a `Customer` row. Only `APPROVED` users can log in. The first admin is created with `npm run seed:admin` in `backend/` (env `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME`); there is no self-registration as admin.
- Auth mechanics: scrypt password hashes and HS256 JWT signed with `AUTH_SECRET` (both via `node:crypto`, no extra dependencies; 12 h TTL). The frontend keeps the token in cookie `td_token` on its own domain and sends `Authorization: Bearer` on every request (`frontend/src/lib/api.ts`); a 401 redirects to `/login`. `frontend/src/proxy.ts` gates pages by the roles in the token payload; the backend re-reads the user from the database on every request (`backend/src/auth/auth.guard.ts`, registered as a global `APP_GUARD`).
- Access policy lives in one place per side: `backend/src/auth/access-policy.ts` (path-prefix rules) and `PAGE_RULES` in `frontend/src/lib/auth.ts`. Change both together. Paths are matched after decoding, lower-casing and collapsing slashes, and a path with no rule needs ADMIN; only `/` (health check) and login/register are public (2026-09-27: Express routes ignore case, so `/API/...` used to skip login and role checks).
- Executive overview (added 2026-09-24, branch feature/overview): `/` renders `ExecutiveOverview` for `ADMIN` only (`HomeDashboard` picks by token roles); other roles that can open `/` (ACCOUNTANT) still see the old placeholder until the user defines their own overview. API `GET /api/overview?date=YYYY-MM-DD` (ADMIN-only, read-only) in `backend/src/overview`: daily spend (Bill/No bill from submissions, inspections, transfers, plate swaps, tax renewals, Yamaha), cash collected (Invoice PAID) and billed, money tied up (in process / delivered-unbilled / receivable + aging), a 4-week cash forecast from customers' real days-to-pay, a per-step table split car/motorcycle (done on the chosen day, cost that day, backlog now, oldest, over-SLA; plus plate swap, tax renewal, Yamaha unsplit), a "รถที่ติดขัด" list of individual vehicles over SLA or flagged (inspection failed/expiring/expired, submission failed, receipt missing with unknown cause, waiting on a plate swap), and action alerts. Each vehicle's current queue comes from `waitsFor` in `backend/src/overview/overview-process.ts`, which mirrors the real queue rules. SLA days per step, the 14-day inspection-expiry warning and the forecast defaults are Claude's choices (`STAGES` in `overview-process.ts`, constants in `overview-calculator.ts`); there is no bank balance, so cash is shown as net flow only. The receipt step (done on the day, receipt-vs-Bill series, and the start of the plate/book wait) uses `DocumentSubmission.receiptDate`, the date printed on the receipt (user's choice 2026-09-25), falling back to `receiptReceivedDate` then `submitDate`.
- Overview duty (user 2026-10-05): the executive overview's spend totals leave out ค่าอากร, as the submit review page does. It reads the duty from the stored `noBillItems` (labels starting `ค่าอากร`, `dutyOfItems` in `overview-calculator.ts`) for submissions, plate swaps and tax renewals, takes it out of `noBill`, and returns it apart: `spend.*.duty`, `cash.daily[].duty`, `spend.categories[].dutyToday/dutyLast30`, `process[].duty` (null where a step has none). The page shows it on its own line (KPI card, daily table, category table, process table footer). Other jobs with their own `dutyAmount` column (vehicle use cancellation, plate copy, vehicle transfer) are not in the overview yet.
- Login hardening (2026-09-27): 5 failed logins per email + client IP in 15 min, then 429; 20 registrations per IP per hour (in memory, reset on restart, single instance; client IP from CF-Connecting-IP, else the X-Forwarded-For entry `TRUSTED_PROXY_HOPS` from the end, default 1; `backend/src/auth/attempt-limiter.ts`). An unknown email runs a dummy scrypt. `GET /api/auth/me` returns `{ user, token }`: a token with the live roles and the same expiry, which AppShell saves so page access follows role changes without logging in again. `?next=` after login is followed only for same-site pages the role can open (`safeNextPath`). The 4-step submit pages are ADMIN / STAFF_CAR / STAFF_MOTO only; read-only roles see no write controls anywhere.
- Customer portal (`/portal`, API `/api/portal/*`): lists the linked company's vehicles with an 8-step status timeline and a "confirm receipt" button (`Vehicle.deliveryConfirmedAt`). It must never expose fees, taxes, or costs. Letting customers add vehicles or documents is a later phase.

