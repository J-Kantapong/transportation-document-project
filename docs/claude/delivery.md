# Delivery: slips, report, other jobs, combined job sheet

Project documentation for Claude Code and Codex. Moved here unchanged from `CLAUDE.md` on 2026-11-16 to keep that file short; `CLAUDE.md` holds the index. Update this file when the feature changes.

- Delivery slips and report (added 2026-09-25): every save on the Delivery page creates one `DeliverySlip` (one customer,
  date and recipient; `slipNo` shown as `DL-00001`) with a `DeliverySlipItem` per vehicle saying what went out this
  time (`receipt` / `book` / `plate`, plus a snapshot of chassis, brand, plate text and receipt number). A later
  plate-only delivery is its own slip. A save may not mix customers. `POST /api/delivery` now also returns
  `slipId` / `slipNo`; `GET /api/delivery/slips?from&to&customerId` and `GET /api/delivery/slips/:id` read them
  (items filtered by the car/moto scope). The page prints the slip for the recipient to sign right after saving;
  `/delivery/report` lists slips by date range and customer, reprints any slip, prints the
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

- Delivery is a top-level menu (user 2026-10-08 "ดึงหน้า delivery ออกมาเลย ให้มาอยู่ข้างหน้าจะได้รวมครบทุกงาน"): pages live at `/delivery`, `/delivery/report`, `/delivery/report/sheet` (menu group "ส่งงานลูกค้า": Delivery for ADMIN / STAFF_CAR / STAFF_MOTO / DELIVERY, the report also for ACCOUNTANT; `PAGE_RULES` and the DELIVERY landing page moved with them). The old `/registration/new-vehicle/delivery...` URLs redirect there (`redirect()` pages), step 8 of the new-vehicle menu keeps a link, overview / search / activity / LINE hrefs point at the new URLs.

- Delivery of other jobs + forget-me-not (user 2026-10-08 "งานควรจะต้อง delivery ใบเสร็จก่อนถึงจะวางบิลได้ ... อยากให้โฟลวเป็นคล้ายๆ กันหมด" + "พนักงานลืมมาลงว่าส่งวันไหน ต้องมีตัวช่วยกันลืม", migration `20261008200000_other_jobs_delivery`, code `backend/src/delivery/job-delivery.ts` + `DeliveryService`): งานโอน, ยกเลิกการใช้รถ, ย้ายออก, คัดแผ่นป้าย and ต่อภาษี now go through the same Delivery step as new vehicles: the receipt (plus the plate for คัดป้าย) is handed to the customer on a DL slip, and only then can the job be billed. The four job tables got `deliveredDate` / `deliveryRecipient` / `deliveryNote` (`TaxRenewal` already had `deliveredDate`, got the other two); `DeliverySlipItem.jobType` (`TRANSFER | USE_CANCEL | PLATE_COPY | MOVE_OUT | TAX_RENEWAL`) + `jobId` + `jobDetail` (snapshot such as "โอนตรวจรถ", printed in the ยี่ห้อ cell) point at the job without a FK, like `InvoiceItem.sourceType/sourceId`. A job enters the Delivery queue when its receipt is back (`returnedDate`; คัดป้าย also `plateReceivedDate`; ต่อภาษี `receivedDate` + `paymentDate`) and it has a `customerId`; it is one receipt-only item (`receipt` true, `book` false, `plate` only for คัดป้าย, kind `FULL`, no plate-later), may share a slip with new vehicles / plate swaps of the same customer and vehicle kind, and `DeliverySource` on both sides = `'VEHICLE' | 'PLATE_SWAP' | JobType`. Queue/recent rows carry `jobLabel`, `jobDetail`, `readySince` (date the item became deliverable; new vehicles = later of book received / receipt received). Slip edit/cancel work on job items too (AuditLog entity of the job, actions `delivery-update` / `delivery-cancel`; billed jobs lock the date / refuse cancel like vehicles); `undo-return` and `cancel` of the four jobs and `PATCH /api/tax-renewals/:id` changing `deliveredDate` / cancelling a tax renewal are refused while a live DL item exists. Billing: `loadJobs` requires `deliveredDate` (`BillableJob.deliveredDate`), so the other-jobs queue only shows delivered jobs; the migration backfilled `deliveredDate = returnedDate` for jobs already in a non-VOID invoice (no slip), everything else returned-but-unbilled went back to the Delivery queue. Combined job sheet: job rows come from DL items (`detail` = `jobDetail`); the per-type sections only list jobs delivered before this feature (`deliveredDate` set, no live DL item, label "ลงไว้ก่อนมีใบ DL", not editable from the sheet; `MOVE_OUT` section added). Vehicle search job rows show "ส่งงานลูกค้าแล้ว" / "รอส่งงาน" and link to the Delivery page. Forget-me-not helpers (user's choice: layers 1+2+3): (1) the record is the printed DL slip; (2) ACCOUNTANT may `GET /api/delivery/queue` and `POST /api/delivery` (access-policy; `currentDeliveryScope` already gives a staff-less ACCOUNTANT every kind), and `components/AwaitingDeliveryPanel.tsx` on `/accounting/billing` (`only="all"`) and `/accounting/billing/jobs` (`only="jobs"`) lists items ready but not delivered, grouped by customer with days waiting, and records the delivery (real DL slip, printable) right there; (3) `lib/delivery-aging.ts` (orange > 3 days, red > 7) badges on the Delivery page cards and rows; overview stage `jobDelivery` (SLA 3, href Delivery page) for jobs returned-not-delivered (tax renewal paid+received-not-delivered too), stuck list entries point at the Delivery page, and alert `delivery-pending` (medium, high when the oldest item waits > 7 days) which the LINE morning/evening cards pick up from the alerts. Not built: menu badge counts, per-staff reminders (no author column), customer portal confirmation for other jobs.

- Combined job sheet (ใบส่งงานรวมทุกงาน, user 2026-10-05, no migration, code in `backend/src/delivery/delivery-sheet.service.ts`, page
  `/delivery/report/sheet` = second tab "ใบรวมทุกงาน" of the delivery report): read-only; pick owner (เจ้าของงาน) +
  date range, prints / saves PDF one sheet per owner x day with a section per job type, no prices, not a DL (no DL number of its own, the
  footer lists the DL numbers included). `GET /api/delivery/sheet?from&to&customerId` -> `{ rows, truncated }` (same access as `GET
  /api/delivery/slips`; DELIVERY sees DL rows only, STAFF_CAR / STAFF_MOTO see their vehicle kind, plate copy included since it has motorcycles, 2026-10-09). The date of a
  row is the job's own "sent" date because only new vehicles + plate swaps have a delivery step: DL slip date (`VEHICLE`, `PLATE_SWAP`,
  cancelled slips/items left out), `TaxRenewal.deliveredDate`, `returnedDate` for vehicle use cancellation / plate copy / vehicle transfer,
  `YamahaRelocationEntry.date` (no owner in the data: shown under a pseudo-owner "ยามาฮ่า (แจ้งย้าย)" only when no owner is picked). A
  wrong date is fixed from the row ("✎ แก้วันที่", reason mandatory): DL rows reuse the slip edit dialog (`PATCH /api/delivery/slips/:id`, whole
  slip), the others call the job's own existing PATCH with just the date + `remark` (`deliveredDate` / `returnedDate` / Yamaha `date` +
  `expectedDate`), so validation, scope and AuditLog are those of each job type; no new write route. Printing: `lib/delivery-sheet.ts`
  (grouping, `canEditSheetRow`), `lib/delivery-sheet-print.ts` (reuses the DL slip styles exported from `lib/delivery-print.ts`).
