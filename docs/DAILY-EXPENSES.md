# ค่าใช้จ่ายรายวัน (Daily expenses)

หน้า `/expenses` (เมนู "ค่าใช้จ่ายรายวัน") และแถบแจ้งเตือน "วันนี้ใช้จ่ายไปแล้ว …" บนหน้าภาพรวม สรุปค่าใช้จ่ายทุกขั้นตอนที่บันทึกไว้ในแต่ละวัน
ระบบไม่มีตารางบันทึกรายจ่ายแยก เพราะคำนวณสดทุกครั้งจากค่าใช้จ่ายที่กรอกไว้ในแต่ละขั้นตอน + เงื่อนไขรายวัน (`DailyExpenseRule`)

## แหล่งค่าใช้จ่าย

| หมวด (`category`) | มาจาก | วันที่ของค่าใช้จ่าย |
|---|---|---|
| `DAILY_RULE` เงื่อนไขรายวัน | `DailyExpenseRule` (ดูด้านล่าง) | วันที่เข้าเงื่อนไข |
| `TRANSFER_NOTICE` แจ้งย้าย/ตัดบัญชี | `Vehicle.transferCost` (เฉพาะ `transferDone`) | `transferCompletedDate` |
| `INSPECTION` ตรวจรถ | `inspectionResultCost` ถ้าบันทึกผลตรวจพร้อมค่าใช้จ่ายแล้ว ไม่อย่างนั้นใช้ `inspectionSentCost` (นับคันละครั้ง ไม่รวมสองช่อง) | `inspectionResultDate` / `inspectionSentDate` |
| `INSPECTION_ROUND2` ตรวจรถรอบ 2 | `inspectionRound2Cost` (เฉพาะ `inspectionRound2Done`) | `inspectionRound2Date` |
| `YAMAHA_RELOCATION` งานแจ้งย้ายยามาฮ่า | `YamahaRelocationEntry.billFee + noBillFee` | `date` |

รายการที่ยอด 0 บาท (เช่น เอารถมาตรวจเอง) ไม่แสดงในรายการค่าใช้จ่าย ภาษีรถประจำปี (`TaxCalculation`) ไม่นับ เพราะเป็นแค่ผลคำนวณ ยังไม่ใช่เงินที่จ่ายจริง
ตรรกะทั้งหมดอยู่ที่ `backend/src/expenses/daily-expense-calculator.ts` (มี unit test)

## เงื่อนไขรายวัน (`DailyExpenseRule`)

| code | รายการ | จำนวน | เงื่อนไข (`trigger`) |
|---|---|---|---|
| `INSPECTION_REQUEST_FEE` | ค่าคำขอตรวจรถ | 25 บาท/วัน | `INSPECTION_DAY`: วันที่มีการตรวจรถอย่างน้อย 1 คัน (มี `inspectionSentDate` หรือ `inspectionRound2Date` ตรงวันนั้น) คิดครั้งเดียวต่อวัน ไม่ขึ้นกับจำนวนคัน |

- ถ้าจะเปลี่ยนอัตรา ให้เพิ่มแถวใหม่ที่ใช้ `code` เดิมแต่ `effectiveFrom` ใหม่ (ใน `backend/prisma/seed.ts` → `seedDailyExpenseRules`) ห้ามแก้แถวเดิม ไม่อย่างนั้นยอดย้อนหลังจะเปลี่ยนตาม
- แต่ละวันใช้แถวที่ `effectiveFrom` ล่าสุดที่ไม่เกินวันนั้น ถ้าแถวนั้น `active = false` แปลว่าปิดเงื่อนไขตั้งแต่วันนั้น
- ถ้าจะเพิ่มเงื่อนไขชนิดใหม่ ให้เพิ่มค่าใน enum `DailyExpenseTrigger` แล้วเขียนการตรวจเงื่อนไขใน `collectExpenseItems`

## API (อ่านอย่างเดียว, จำนวนเงินเป็นบาท)

- `GET /api/expenses/daily?date=YYYY-MM-DD` → `{ date, total, count, categories: [{ category, label, count, total }], items: [{ id, category, categoryLabel, label, detail, amount }] }`
- `GET /api/expenses/daily-totals?from=YYYY-MM-DD&to=YYYY-MM-DD` (ไม่เกิน 93 วัน) → `{ days: [{ date, total, count }] }` (ครบทุกวันในช่วง รวมวันที่ยอดเป็น 0)
- `GET /api/expenses/rules` → `{ rules: [{ id, code, label, trigger, triggerLabel, amount, effectiveFrom, active, note }] }`

ถ้าพารามิเตอร์ผิด จะได้ 400 `{ error }` เป็นภาษาไทย type ฝั่ง frontend อยู่ที่ `frontend/src/lib/api.ts` (`DailyExpenseSummary`, `DailyExpenseTotal`, `DailyExpenseRule`)
