# Receipts (step 5): duplicate uploads, background reading, receipt dates, CC from receipt

Project documentation for Claude Code and Codex. Moved here unchanged from `CLAUDE.md` on 2026-11-16 to keep that file short; `CLAUDE.md` holds the index. Update this file when the feature changes.

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

- CC from the receipt (user 2026-11-09 "ในใบเสร็จมี CC อยู่", no migration): the service-fee rate of a motorcycle is picked from the keyed `Vehicle.cc`, and a motorcycle's receipt amount cannot reveal a wrong CC (flat tax), so the CC printed on the DLT receipt is the check. (1) The receipt reader returns `reading.cc` (`ReceiptReadingSchema`, prompt line, `cc` in `RECEIPT_FIELDS` / uncertain-field aliases; receipts read before this have no `cc`, nothing is re-read). (2) `backend/src/receipts/receipt-cc.ts`: `receiptCcOf(receipts)` = the CC of the newest reading that is not `chassis-mismatch`; `ccDiffers` / `receiptCcMismatch` treat a difference under `RECEIPT_CC_TOLERANCE` = 1 cc as equal (receipts may round 149.5 to 150; Claude's choice). (3) `POST /api/vehicles/document-submission/:id/apply-receipt-cc` `{ remark? }` (same SUBMIT access as the other receipt routes, PENDING or RECEIPT_RECEIVED) = "ใช้ CC ตามใบเสร็จ": sets `Vehicle.cc` to the receipt's CC and, for a `รย.12-<range>` body, moves the body to the range that holds it (`motorcycleBodyForCc` in `vehicle-validation.ts`; รย.17 and cars keep their body), writes a `VehicleEditLog` row, never recomputes the submission's Bill (motorcycle fees do not depend on the bracket), no edit-impact confirm (the receipt is the authority, but a person must click because the AI can misread). (4) `listDocumentSubmissions` vehicles carry `cc` (unused by the UI so far: the user chose 2026-11-09 to check only on the billing page, so the receipt page shows no CC warning). (5) `GET /api/billing/queue` vehicles carry `submissionId`, `receiptCc` and `ccWarning` (receipt mismatch, else `motorcycleCcMismatch` of body vs CC); a vehicle with `ccWarning` cannot be ticked until the accountant clicks "ใช้ CC ตามใบเสร็จ" in "แก้" (reloads the queue so the suggested rate follows the new CC), edits the vehicle, or ticks "ตรวจกับใบเสร็จจริงแล้ว" (`receiptChecked`, the same flag as the amount check). Unit-tested (`receipt-cc.spec.ts`); not browser-tested and not yet run against a real receipt, so the prompt wording for the CC label ("ซีซี" / "CC" / "ความจุกระบอกสูบ") should be checked on the first real reads. Not built: re-reading old receipts for CC, a CC check on receipts of the other jobs.
