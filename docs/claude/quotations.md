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

- Move-in transfers on a quotation (user 2026-11-18: quote after the job is done, "เพราะผมไม่รู้ราคาที่แน่ชัดว่าเท่าไหร่"): the JOB form has
  "งานโอนย้ายเข้า: ดึงงานที่รับใบเสร็จแล้วของลูกค้านี้" (`GET /api/billing/quotations/move-in-jobs?customerId=`, `QuotationService.moveInJobs`).
  It lists the customer's `VehicleTransfer` rows with `transferType` MOVE_IN that are returned (receipt received), not cancelled and not on a
  non-VOID invoice; delivery (DL) is not required for quoting. Each job offers a FEE line = the real receipt amount (`receiptAmount`, else
  the system's `billTotal`, shown as an estimate) and a SERVICE line from the customer's `JobFeeRate` (TRANSFER / MOTO / variant MOVE_IN,
  cost = No Bill + ค่าอากร) - no rate set = no service line, the accountant adds it. ค่าอากร is not a line (same rule as other-jobs billing).
  Ticked jobs are appended to the editable rows as plain lines. **They are not linked to the jobs**: after "ออกใบวางบิลจากใบนี้" the jobs still sit
  in the other-jobs billing queue and must be closed there (วางบิลนอกระบบ) to avoid billing twice, and the same job can be pulled into two
  quotations. Linking quotation lines to jobs (so the queue clears itself) is not built.
