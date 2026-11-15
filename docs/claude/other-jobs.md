# Other jobs: vehicle use cancellation, move out, plate copy, vehicle transfer

Project documentation for Claude Code and Codex. Moved here unchanged from `CLAUDE.md` on 2026-11-16 to keep that file short; `CLAUDE.md` holds the index. Update this file when the feature changes.

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

- Move out (ย้ายออก, user 2026-10-06, migration `20261006240000_vehicle_move_out`, code in `backend/src/vehicle-move-out/`, pages `/registration/other/move-out/{car,moto}/{submit,return}`): third subtask of "อื่นๆ", a copy of vehicle use cancellation ("เก็บข้อมูลแบบยกเลิกการใช้รถเลย"): same fields (job owner, owner name, engine, chassis, brand, plate หมวด + เลข, submit date), same two steps (ยื่น -> รับใบเสร็จ with OCR, `ReceiptImage.vehicleMoveOutId`), same access (`ADMIN` / `STAFF_CAR` / `STAFF_MOTO` write by vehicle class, `ACCOUNTANT` read), remark + `AuditLog` entity `VehicleMoveOut`, soft cancel. Fees (user 2026-10-06, `vehicle-move-out-fee.ts`, copied in `frontend/src/lib/vehicle-move-out-fee.ts`) are given for **motorcycles only**: Bill 25, No Bill = ลงขัน 80 + ด่วนเพิ่ม 50 when `urgent`, ค่าอากร 10 kept apart (not in No Bill, not in the total), snapshotted in `billTotal` / `noBillTotal` / `dutyAmount`; the backend computes them and ignores client amounts. **Cars have no rate yet**: amounts are 0 and `urgent` is refused (400). Editing keeps the snapshot unless the urgent tick changes (then No Bill is recomputed). API `/api/vehicle-move-outs` (same routes as `/api/vehicle-use-cancellations`, result key `moveOut` / `moveOuts`). Not built: car fees, Delivery, combined job sheet, billing, executive overview.

- Plate copy (คัดแผ่นป้ายทะเบียน, user 2026-10-02, migration `20261002160000_plate_copy`, code in `backend/src/plate-copy/`, pages
  `/registration/other/plate-copy/{submit,return,receive-plate}`): second subtask of "อื่นๆ", built like vehicle use cancellation
  (same fields: job owner, owner name, engine, chassis, brand, plate หมวด + เลข, submit date; receipt step with OCR) with a third step, receive
  plate. Cars and motorcycles share the same pages (motorcycles added 2026-10-09, see the end of this paragraph): `vehicleClass`
  CAR | MOTO is a field of the submit form and cannot change afterwards; STAFF_CAR writes car jobs, STAFF_MOTO motorcycle jobs,
  ADMIN both, ACCOUNTANT reads. Fixed fees snapshotted at submit, car: Bill 205, No Bill 100, ค่าอากร 10 kept apart (not in No Bill, not in the total);
  constants in `plate-copy-fee.ts` (copied in `frontend/src/lib/plate-copy-fee.ts`). Receive plate = a card per job with a
  camera / gallery photo of the plate, the received date (not before the submit date, not after today) and a confirm
  button; the photo is required, stored in `PlatePhoto` (hash-checked, `PlateCopy.platePhotoId` + `plateReceivedDate`), no AI,
  not tied to the receipt step. The usual wait is 15 working days (user 2026-10-09; Monday to Friday, public holidays are not
  known to the system), so the card shows the expected date (`plateCopyDueDate` = submit + 15 working days) and an overdue
  warning (`PLATE_COPY_EXPECTED_DAYS`; information only); the overview's plateCopyPlate SLA is the calendar equivalent, 21 days
  (`PLATE_COPY_EXPECTED_CALENDAR_DAYS`). Correcting the date / detaching the photo needs a remark and goes to
  `AuditLog` entity `PlateCopy`, like edit / cancel / undo-return / receipt changes after return; cancel is soft and frees
  the receipt and plate photo hashes. Receipts use `ReceiptImage.plateCopyId` (the old receipts guards skip these rows).
  API `/api/plate-copies` (`GET ?status&month`, `POST`, `PATCH /:id`, `PATCH /:id/return`, `POST /:id/undo-return`,
  `POST /:id/cancel`, `POST/DELETE /:id/receipts`, `PATCH /:id/receipt-fields`, `GET /plate-queue?status`,
  `POST /:id/plate-photo` (multipart `file`, `date`), `PATCH /:id/plate-photo/date`, `POST /:id/plate-photo/detach`,
  `GET /:id/plate-photo/image`). Plate type (user 2026-10-08, migration `20261008100000_plate_copy_type`): `PlateCopy.copyType` = `BOTH` (default = คู่ปกติ, plate fee 200) | `SINGLE_NORMAL` (100) | `BOTH_AUCTION` (1,200) | `SINGLE_AUCTION` (600); Bill = ค่าคำขอ 5 + plate fee (so 205 / 105 / 1,205 / 605); No Bill 100 and duty 10 unchanged for every type (Claude choice); `plateCopyBillFee` in both fee files; create/update take `copyType`, changing it on edit recomputes Bill. Motorcycles + urgent (user 2026-10-09, migration `20261009120000_plate_copy_moto_urgent` = `PlateCopy.urgent Boolean default false`, additive): the submit form has ประเภทรถ (รถยนต์ / รถจักรยานยนต์, limited to the classes the user may write; one class = locked) and a งานด่วน tick for both classes. MOTO: one plate, so `copyType` is forced to `SINGLE_NORMAL` (picker hidden; any other value = 400), Bill 105 (ค่าคำขอ 5 + ค่าแผ่นป้าย 100), No Bill = ลงขัน 60 + ลงขันด่วนเพิ่ม 50 when `urgent`, duty 10 apart. CAR: unchanged (Bill by `copyType`, ลงขัน 100, duty 10) plus ลงขันด่วนเพิ่ม 100 when `urgent` (`PLATE_COPY_CAR_URGENT_FEE`, confirmed by the user 2026-10-09). `calculatePlateCopyFees(vehicleClass, copyType, urgent)` in both fee files; the backend computes and snapshots `billTotal` / `noBillTotal` / `dutyAmount` and ignores client amounts; on edit (remark required) changing `urgent` recomputes No Bill and changing a car's `copyType` recomputes Bill, anything else keeps the snapshot; `vehicleClass` sent on edit is ignored. Rows return `vehicleClass` + `urgent`; `GET /api/plate-copies` and `/plate-queue` take an optional `vehicleClass` and without it return every class the user may read (STAFF_CAR cars, STAFF_MOTO motorcycles, ADMIN / ACCOUNTANT all), write checks use the job's own class (`assertClassScope`), a motorcycle's plate photo is stored as `PlatePhoto.kind` `moto`. Every list / card shows the class (and งานด่วน). Page rule `/registration/other/plate-copy` = ADMIN / STAFF_CAR / STAFF_MOTO / ACCOUNTANT. Delivery, billing (`JobFeeRate` class CAR | MOTO), combined job sheet, vehicle search, activity and the overview all read the job's real class. Not built: motorcycle plate types other than a single normal plate.

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
