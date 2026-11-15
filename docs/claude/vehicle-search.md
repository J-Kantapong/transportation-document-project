# Vehicle search page and other jobs in the search

Project documentation for Claude Code and Codex. Moved here unchanged from `CLAUDE.md` on 2026-11-16 to keep that file short; `CLAUDE.md` holds the index. Update this file when the feature changes.

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

- Other jobs in the vehicle search (user 2026-10-08 "รวมทุกงาน", no migration, `backend/src/vehicle-search/job-search.ts`): the search page
  also lists jobs that live in their own tables (plate swap, vehicle use cancellation, move out, plate copy, transfer, tax
  renewal) when a search text is typed, in a second table "งานอื่นๆ ที่ตรงกับคำค้น" under the vehicles (hidden while a
  new-vehicle status chip is active; counts and chips stay vehicle-only). `GET /api/vehicle-search/jobs?q=&from=&to=&kind=` ->
  `{ jobs[{ type, typeLabel, date (submit date), kind, customerName, ownerName, chassis, engine, plate, brandName, status, done,
  cancelled, href }], truncated, allowed }`; `q` is required, 30 newest per type, same matching as vehicles (chassis, engine,
  plate incl. "ตค 8772", names, customer; plate swap also the new plate and the linked new vehicle's chassis), `from`/`to` filter
  the submit date, cancelled jobs are listed as "ยกเลิกแล้ว". Access = `SUBMIT_READ` roles (ADMIN / STAFF_CAR / STAFF_MOTO /
  ACCOUNTANT; others get `allowed: false`), vehicle kind by `vehicleScopeFor`. Yamaha relocation is not searchable (daily counts,
  no vehicle data). "ไปที่งาน →" opens the job's page with `?focus=<chassis>` (best effort, those pages do not all scroll to it).
