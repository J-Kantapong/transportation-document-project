# Receive plate / book (steps 6-7), no AI

Project documentation for Claude Code and Codex. Moved here unchanged from `CLAUDE.md` on 2026-11-16 to keep that file short; `CLAUDE.md` holds the index. Update this file when the feature changes.

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

- Vehicles that did not buy a plate (user 2026-11-18 "รถคันที่ไม่ซื้อป้ายไม่ต้องรับป้าย ... ไม่ต้องแนบรูปแผ่นป้าย", no migration):
  `plateNotRequired()` in `backend/src/vehicles/plate-requirement.ts` is the one rule, read from the vehicle's latest
  `DocumentSubmission`: `plateNumberOption` NORMAL / AUCTION + `includePlateFee` false (รวมค่าแผ่นป้าย not ticked) + no new plate
  ordered (`newPlateOption` NONE / null; a new plate ordered = still a plate to receive, Claude's choice). Such a vehicle never enters
  the receive-plate queue and needs no plate photo; overview / my-work / vehicle search (`waitsFor`) raise no `plate` wait; on
  Delivery it goes out as a book-only item (`kind` NO_PLATE, rows and slip items carry `plateNotRequired`, shown "ไม่ซื้อป้าย" /
  "เล่ม (ไม่ซื้อป้าย)") and is `DONE` once the book is delivered (not in the queue, not in ป้ายค้างส่ง, not counted as
  `platePending`, printed slip says "ไม่ซื้อแผ่นป้าย N คัน"); the customer portal drops the plate step and treats book delivery as
  complete. If a plate photo was attached anyway (`plateReceivedDate` set), the normal rules apply. Always call `plateNotRequired`
  (select `PLATE_OPTION_SELECT`), never test `plateReceivedDate` alone to decide "waiting for plate".
