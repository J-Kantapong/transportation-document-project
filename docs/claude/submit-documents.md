# Submit documents (step 4): 4-URL flow, cancelling a submission

Project documentation for Claude Code and Codex. Moved here unchanged from `CLAUDE.md` on 2026-11-16 to keep that file short; `CLAUDE.md` holds the index. Update this file when the feature changes.

- Tax-exempt vehicle + supplier inspection tick (user 2026-11-16, migration `20261116100000_submission_tax_exempt_supplier_inspection`, additive):
  two more options in the ตัวเลือก column of `/submit/settings`, sent with the other options to `preview-bulk` / `bulk` and stored on
  `DocumentSubmission` (`taxExempt` default false, `supplierInspection` default true). **รถยกเว้นภาษี** (cars and motorcycles, office and
  supplier routes): the Bill drops ค่าคำขอ, ค่าตรวจสภาพรถ and ค่าใบคู่มือ, so a plain car is ค่าแผ่นป้าย 200 only (plate-number / new-plate
  requests and ค่าธรรมเนียมอื่นๆ ขอใช้จังหวัดอื่น still apply; No bill is unchanged - Claude's choice, the user only named the three
  lines), the annual tax is 0 (`taxAmount` 0, no `TaxCalculation` row; preview tax has `status: 'EXEMPT'`), and `currentBillEstimate`
  (billing / overview / my-work) passes `taxExempt` so the receipt check uses the same Bill; `receiptSizeHints` returns none.
  **ซับนำรถเข้าตรวจสภาพ** (supplier-route vehicles only, unticked = the customer took the vehicle to inspection): the
  "นำรถเข้าตรวจสภาพ" line stays in `noBillItems` with amount 0. Unit-tested in `document-fee-calculator.spec.ts`; not browser-tested
  (the migration is not on the dev database).

- Cancelling a submission (added 2026-09-25): each PENDING row (cars and motorcycles) on
  `/registration/new-vehicle/submit-documents/records` has "ยกเลิก" (ADMIN / STAFF_CAR / STAFF_MOTO, in their vehicle
  scope). Attached receipt photos are detached back to the unmatched pool (the dialog warns about it). `POST /api/vehicles/document-submission/:id/cancel` `{ remark }` deletes the submission so the vehicle returns
  to the submit queue and can be submitted again with freshly calculated fees; a snapshot + remark goes to
  `VehicleEditLog` and the cash ledger is refunded. Unlike FAILED, nothing is kept. Editing a single submission's price
  was tried and dropped (user 2026-09-25); changing fee rates for future submissions is still undecided.

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
