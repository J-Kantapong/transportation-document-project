# Tax invoices, 50 ทวิ from customers, credit terms, pay schedule

Project documentation for Claude Code and Codex. Moved here unchanged from `CLAUDE.md` on 2026-11-16 to keep that file short; `CLAUDE.md` holds the index. Update this file when the feature changes.

- Tax invoices + 50 ทวิ + credit terms (user 2026-09-28, migration `20260929120000_tax_invoices`, code in
  `backend/src/billing/tax-invoice.*`, page `/accounting/tax-invoices` + `/wht`): a ใบกำกับภาษี/ใบเสร็จรับเงิน (`TaxInvoice`)
  is issued when the money comes in, only for COMPANY-account bills with VAT, 1 bill = 1 active TV (partial unique index
  `TaxInvoice_invoice_active_key`). Number `TV{year}-{3 digits}` from `TaxInvoiceSeries` (row-locked, date = paid date, a
  date is compared with the year's latest-dated live (not cancelled) TV only, user 2026-10-06 so a cancelled TV does not block an earlier date; user 2026-10-19: a date before it is allowed **within the same month** when the request carries `backdateConfirmed: true` (the dialogs ask first via `checkBackdate` in `frontend/src/lib/tax-invoice-date.ts`; numbers then no longer follow dates inside that month), an earlier month is still refused, for both bill-based and custom TVs; `lastIssued` in the previews is the latest-dated live TV); no series row = not enabled yet (old "รับเงินแล้ว" + typed TV no. still
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
  Pay schedule by weekday (user 2026-10-31, SPI: "วางบิลสัปดาห์นี้ วันพฤหัสหน้าได้เงิน", migration `20261031120000_customer_pay_schedule`,
  additive): `Customer.billingPayWeekday` (1 = Monday .. 5 = Friday, null = use credit days) + `billingPayWeeksAfter` (default 1 =
  the week after the issue week, 0 = same week, max 4). Rule in `backend/src/billing/payment-schedule.ts` (copied in
  `frontend/src/lib/payment-schedule.ts`): weeks start on Monday, `Invoice.dueDate` = that weekday of the issue week + N weeks
  (a Saturday/Sunday issue date still counts as its own week; pushed one week when it would fall before the issue date); it wins
  over credit days. Terms API takes `payWeekday` / `payWeeksAfter`; saving a changed schedule (or credit days) recomputes `dueDate`
  of that customer's ISSUED invoices at once (AuditLog `update-terms` carries `dueDatesRecomputed`), and editing a bill's issue
  date recomputes from the schedule instead of shifting. `dueDate` is shown as "คาดรับเงิน": the badge
  "เลยวันคาดรับเงิน N วัน - เช็กว่าได้รับแล้ว?" (`components/InvoiceDueBadge.tsx`, the usual cause is a payment not keyed in) sits on
  the billing invoice list and on the tax invoice page's "บิลรอรับเงิน - ออกใบกำกับได้" panel (past-due first), the overview / my-work alerts are
  unchanged, and the LINE finance card gets a red "เลยวันคาดรับเงิน" line per customer (`FinancePending.receivables.pastDue`,
  built with `overdueByCustomer`). Public holidays are not known: the reminder then comes one day early (user's choice).
  Dev DB migrated and browser-tested on dev 2026-11-01 (SPI set to Thursday next week: PB2026-003 issued Thu 08/10 got 15/10 and the
  red badge; the test left SPI's dev terms on that schedule).
  e-Tax preparation (user 2026-10-06, migration `20261006100000_tax_invoice_seller_snapshot`): every new TV stores the seller
  (`TaxInvoice.sellerSnapshot`, from `backend/src/billing/seller-profile.ts`, a copy of `COMPANY_PROFILE`; change both when
  the company data changes) and the buyer snapshot now carries `email`; `seller` is null on older TVs and the print falls back
  to the current company profile. The issue dialog hints when the customer has no email. Paper stays until 2027.
  Monthly accounting package (user 2026-10-06, no migration, frontend only): the "📦 ชุดส่งบัญชี (ZIP)" button on
  `/accounting/tax-invoices` builds one ZIP for the chosen month in the browser (`frontend/src/lib/accounting-bundle.ts`, zip by
  `fflate`): `tax-sales-report.xlsx` (sheet "ภาษีขาย" = the sales-tax report plus ค่าธรรมเนียมทดรองจ่าย, รวม, หัก ณ ที่จ่าย, รับสุทธิ, 50 ทวิ
  status and a totals row of the live invoices; sheet "50 ทวิ" = what customers withheld and which file covers it),
  `tax-invoice-copies.pdf` (a copy page per invoice in number order, cancelled ones watermarked; `buildTaxInvoiceBundleHtml` through
  `htmlToPdfBlob` in `pdf-export.ts`, which also page-breaks at `section.page`), `50tawi/` (the attached 50 ทวิ files, named with the
  TV numbers they cover) and `summary.txt`. File names inside are ASCII. The system does not send email: the user downloads the
  ZIP and attaches it (a notice warns above 20 MB). The plain Excel button uses the same workbook builder.
  The tax invoice list page also has a panel of company-account bills waiting for payment with the issue dialog, and the custom
  tax invoice page links a customer's waiting bills to `/accounting/tax-invoices?issue=<invoiceId>`.
  Per-customer default 50 ทวิ type (user 2026-10-06, migration `20261006230000_customer_wht_method`): `Customer.billingWhtMethod`
  PAPER (default) | EWHT, set in the terms editor (`whtMethod` in `PATCH /api/billing/customers/:id/terms`, shown when the customer
  withholds); the issue dialog and the custom tax invoice page preselect it (`defaultWhtMethod` in the preview) and it can be changed
  per invoice. Today YM and Lexus Auto City are e-WHT, everyone else paper. Issued invoices are not affected.
  Tax invoice before payment (user 2026-10-15, Yamaha must receive the TV before it pays; migration
  `20261015100000_tax_invoice_before_payment`, additive): `Customer.billingTaxInvoiceBeforePayment` (checkbox in the terms editor,
  `taxInvoiceBeforePayment` in the terms API, nobody is set by default: tick it for YM) lets the issue dialog choose "ออกก่อนรับเงิน"
  (default for such a customer) = `POST .../invoices/:id/tax-invoice` with `beforePayment: true`: `paidDate` is then the TV date
  (>= bill date; may be a future date up to `TAX_INVOICE_ADVANCE_DAYS` = 31 days ahead, user 2026-10-15, the day Yamaha will pay; same number/date-order rule, so after a future-dated TV every other TV must carry that date or later, and the dialog warns + confirms), `TaxInvoice.beforePayment` = true, the bill stays ISSUED with
  `taxInvoiceNo` set and no `paidDate`, and no 50 ทวิ is attached yet. Output VAT falls in the month of the TV date. When the money
  comes in, "บันทึกรับเงิน" on the invoice list = `PATCH .../invoices/:id/paid` (allowed although the series is enabled because the
  bill has a live TV; the TV number always comes from that TV). A bill with a live TV cannot be edited or voided (409, cancel the TV
  first); cancelling an unpaid advance TV only clears the bill's `taxInvoiceNo`; `unpay` is allowed for a paid bill whose TV was
  issued before payment (the TV stays). Such TVs are left out of the 50 ทวิ pending list / overview / my-work alert while the bill is
  unpaid (`WHT_PENDING_WHERE`), and out of the "บิลรอรับเงิน - ออกใบกำกับได้" panel. The receivable (Invoice ISSUED) and cash
  (Invoice PAID) are unchanged. Not browser-tested (migration not on the dev database before push).
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
