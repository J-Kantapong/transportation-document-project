# Quotations (ใบเสนอราคา)

Project documentation for Claude Code and Codex. Moved here unchanged from `CLAUDE.md` on 2026-11-16 to keep that file short; `CLAUDE.md` holds the index. Update this file when the feature changes.

- Quotations (ใบเสนอราคา, user 2026-10-01, migration `20261001090000_quotations`, code in
  `backend/src/billing/quotation.*`, pages `/accounting/quotations` (list), `/new` (`?edit=<id>` = edit a draft),
  `/view?id=`): YM's work must be quoted and approved (YM sends back a PO as a PDF with a number) before every bill, and
  the same flow works for any customer. `Quotation.kind`: `JOB` = an amount for a job (lines like `InvoiceItem`), `RATE` =
  per-vehicle prices (lines carry the `ServiceFeeRate` fields). Status `DRAFT` (no number, freely edited or deleted) ->
  `ISSUED` -> `APPROVED` | `REJECTED`, plus `CANCELLED` and `SUPERSEDED`; the screen groups by `stage` (`stageOf`:
  WAITING / EXPIRED by `validUntil`, DONE once billed or applied as rates). Number `QT{year}-{3 digits}` from
  `QuotationSeries` (one series for both accounts, row-locked, created on first use), given at issue; ADMIN can set
  the last number already used outside the system (user 2026-10-30: the old system reached QT2026-022) in the panel at the
  bottom of `/accounting/quotations` (`GET /api/billing/quotations/series`, `POST .../series/set` `{ year, lastNumber, remark }`,
  never below the highest number issued in the system, AuditLog entity `Quotation` id `series-<year>` action `set-last-number`); an issued
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

- Customer jobs on a quotation (user 2026-11-18: quote after the job is done, "เพราะผมไม่รู้ราคาที่แน่ชัดว่าเท่าไหร่"; first built for move-in
  transfers only, widened the same day: "ควรมีงานทุกแบบมาเลยของลูกค้านั้นๆ"; migration `20261118120000_quotation_item_job_link`): the JOB form has
  "งานอื่นๆ ของลูกค้า: ดึงงานที่เสร็จแล้วของลูกค้านี้" (`GET /api/billing/quotations/customer-jobs?customerId=&quotationId=`,
  `QuotationService.customerJobs`). It lists every other-job type of the customer that is done - transfers of all three types, vehicle use
  cancellation, plate copy, move out (receipt returned) and tax renewal (paid) - through `BillingService.jobsForQuotation`, the billing
  loader without the delivery requirement, so a job can be quoted before its DL slip. Each job offers a FEE line = the real receipt amount
  (else the system's `billTotal`, shown as an estimate; tax renewal = the tax paid) and a SERVICE line from the customer's `JobFeeRate`
  (cost = No Bill + ค่าอากร) - no rate set = no service line, the accountant adds it. ค่าอากร is not a line (same rule as other-jobs billing).
  A move-in transfer and the move-out it was prefilled from (`VehicleTransfer.moveOutId`) come back as a pair (`pairedWith`) and are ticked
  and unticked together. Ticked jobs are appended to the editable rows and each pulled line is linked to its job:
  `QuotationItem.sourceType` (the job type) + `sourceId`, no FK, sent back per line in `items` (description and amount stay editable;
  deleting the line drops the link; "ทำฉบับแก้ไข" copies the links). Rules:
  - Saving (`attachJobLinks`) refuses a job that is not this customer's done, non-cancelled job, or that is already taken
    (`jobsTaken`): on a non-VOID invoice, closed as billed outside, or on another quotation in DRAFT / ISSUED / APPROVED (the draft being
    edited and the quotation it revises do not count). `customer-jobs` hides taken jobs the same way (`&quotationId=` = the draft being edited).
  - The other-jobs billing queue (`BillingService.loadJobs`) treats a job linked to an ISSUED / APPROVED quotation as already billed
    (`billedInvoiceNo` = the invoice number once invoiced, else "ใบเสนอราคา QT…"), so it leaves the queue and cannot be billed there; a
    cancelled / rejected / superseded quotation or a DRAFT frees it again. The invoice made from the quotation keeps plain custom lines
    (no `InvoiceItem.sourceType`), so its printed face is unchanged.
  - "ออกใบวางบิลจากใบนี้" (`assertLinkedJobsBillable`) requires every linked job to be delivered (DL slip, the same rule as the queue),
    not cancelled and not billed or closed elsewhere.
  Not built: a marker on linked rows in the editor, pulling new-registration vehicles.
