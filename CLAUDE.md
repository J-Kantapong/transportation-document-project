# Transportation document project

This private repository is the shared development surface for the user, Claude Code, and Codex.

## Repository structure

- `frontend/`: Next.js application created for the production implementation.
- `backend/`: NestJS application created for the production database/API implementation.
- `prototype/sites-reference/`: the latest working UI and database prototype designed in Codex and published separately through OpenAI Sites.

## Collaboration rules

- Read `prototype/sites-reference/docs/SHARED-PROJECT.md` and `prototype/sites-reference/docs/VEHICLE-ENTRY.md` before implementing the matching features in `frontend/` or `backend/`.
- Treat the prototype as the product specification and visual reference. Port features into the existing Next.js and NestJS applications; do not replace those applications with the prototype runtime.
- Preserve the Thai labels, navigation, 7 customer fields, 16 vehicle-entry fields (the original 12 plus `ประเภทเจ้าของรถ`, `ไฟแนนซ์`, `ชื่อผู้ถือกรรมสิทธิ์` and `ชื่อผู้ครอบครอง`, added 2026-09-22), 77-province list, and the 14 unique vehicle-type choices (the original 13 plus `รย.17-จักรยานยนต์สาธารณะ`, added 2026-10-08) unless the user changes them.
- The user defines workflows incrementally. Do not invent fields or workflows for registration tasks that remain empty.
- Keep frontend and backend contracts documented when either changes.
- Do not commit credentials, production customer data, local database files, or deployment tokens.
- Do not deploy or make this repository public unless the user explicitly asks.
- Deployments: `master` is production, `dev` is the separate dev environment (own Neon branch, own Render service, Vercel preview). See `DEPLOYMENT.md`.

## Feature documentation (read before working on a topic)

The detailed product state, API contracts and user decisions live in `docs/claude/`, one file per topic (moved out of this file unchanged on 2026-11-16 to keep it short). **Before changing or answering about a topic, read its file. After changing a feature, update that file, not this one;** add a new file and a row here for a new topic.

| File in `docs/claude/` | Covers |
|---|---|
| `vehicle-entry.md` | Step 1 entry (single / batch), 14 vehicle types and the motorcycle rule, owner type / finance / owner names, soft delete + restore, saved-vehicle list, CC range check, wrong-data warnings |
| `transfer-notice-supplier.md` | Step 2 แจ้งย้าย receipt (required, split, waive) and its share on the bill; supplier route for provinces other than กรุงเทพมหานคร / สมุทรปราการ, `SupplierProvinceRate` |
| `submit-documents.md` | Step 4: the 4-URL submit flow, cancelling a PENDING submission |
| `receipts.md` | Step 5: duplicate-upload hash, background AI reading, receipt date vs received date, receipt-fields correction, CC from the receipt |
| `receive-plate-book.md` | Steps 6-7: photo attach without AI, ใบยื่น cards, filters, print |
| `delivery.md` | Step 8 and the top-level Delivery menu: DL slips, report, edit / cancel, other jobs on a slip, forget-me-not helpers, combined job sheet |
| `vehicle-search.md` | `/vehicles` search, statuses, focus links, other jobs in the search |
| `plate-swap.md` | การสลับเลข |
| `yamaha-relocation.md` | งานแจ้งย้ายยามาฮ่า daily counts and attachments |
| `other-jobs.md` | ยกเลิกการใช้รถ, ย้ายออก, คัดแผ่นป้าย, งานโอน (tables, fees, steps, API) |
| `tax-renewal.md` | ต่อภาษี: job owner, receipt page, รถตาม พ.ร.บ.ขนส่ง (ขส.) |
| `billing.md` | Collection accounts (company / personal), `ServiceFeeRate` matching and add-ons, tick-only billing, receipt checks, custom invoices, per-bill WHT, other jobs in billing, `JobFeeRate`, close-billed-outside, invoice face layout, removed customer-payments page |
| `tax-invoices.md` | ใบกำกับภาษี (TV) series and rules, custom TV, TV before payment, customer 50 ทวิ, credit terms, pay schedule by weekday, monthly accounting ZIP |
| `quotations.md` | ใบเสนอราคา: JOB / RATE, numbering, approval + PO, Yamaha monthly quotations |
| `hr-payroll-wht.md` | Employees, payroll runs, payslips + signature, 50 ทวิ issued by the company, supplier register (ADMIN only) |
| `auth-roles.md` | Roles, vehicle-kind scope (read vs write), register / approve flow, JWT, access policy, login hardening, customer portal |
| `overview-activity-mywork.md` | Executive overview (`/`), alerts and their links, duty handling, work activity page, my-work page |
| `line-bots.md` | Personal secretary on LINE (cards, commands, reminders, finance card, provincial rate lookup), customer LINE bot (menu, ตรอ. and tax checks), statement -> tax invoice, Yamaha payment mail |
| `ui-conventions.md` | `DateInput`, tabs as URLs, weekend / multi-vehicle date guards and bulk date correction, photo sheet tool |
| `production-audit-2026-09-27.md` | Cross-cutting rules from the 57-fix audit: stale-save 409s, date order, corrections with a reason, list paging, `AuditLog`, soft cancel, edit-impact confirm |

## Rules that apply everywhere

Short reminders; the topic files have the detail.

- Motorcycle = `Vehicle.body` starting `รย.12-` or `รย.17-`: use `isMotorcycleType` / `motorcycleTypeWhere` (backend) and `isMotorcycleBody` (frontend), never `startsWith('รย.12-')`.
- Nothing is hard-deleted: soft delete / soft cancel, with a mandatory `remark`. Vehicle changes are logged to `VehicleEditLog`, everything else to `AuditLog` (`writeAudit` in `backend/src/audit/audit-log.ts`), in the same transaction.
- `Vehicle.chassis` is unique only among non-deleted rows (partial index): never `findUnique({ where: { chassis } })`, and every vehicle query filters `deletedAt: null`.
- Access is defined once per side and changed together: `backend/src/auth/access-policy.ts` and `PAGE_RULES` in `frontend/src/lib/auth.ts`. A path with no rule needs ADMIN. STAFF_CAR / STAFF_MOTO are limited to their vehicle kind (`backend/src/auth/vehicle-scope.ts`).
- Fees are computed and snapshotted by the backend; amounts sent by the client are ignored. Fee constants in `backend/src/**/*-fee.ts` have a copy under `frontend/src/lib/`; change both.
- ค่าอากร is kept apart from No Bill totals and grand totals. The customer portal and Delivery documents never show prices.
- Server "today" is Bangkok (`bangkokToday()`); every date box is `components/DateInput.tsx` and accepts a Buddhist year.
- Saves send what the user saw (`expected...`) and the server answers 409 when it changed; queue pages reload on focus.
- Migrations are additive; dropping tables or columns needs the user's explicit go-ahead.
