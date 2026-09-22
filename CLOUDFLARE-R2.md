# Cloudflare R2 – ที่เก็บรูปภาพของระบบ

สรุปสิ่งที่ตัดสินใจและทำไปแล้วเรื่อง Cloudflare R2 (อัปเดต 2026-09-22, commit `3403a27`)

## ทำไมต้องใช้ R2

- รูปที่ระบบเก็บมี 3 ประเภท: **ใบเสร็จ** (ReceiptImage), **รูปป้ายทะเบียน** (PlatePhoto), **รูปเล่มทะเบียน** (BookPhoto)
- Backend อยู่บน Render ซึ่ง **ล้างดิสก์ทุกครั้งที่ deploy** → เก็บรูปบนดิสก์ของ Render ไม่ได้ ต้องใช้ object storage แยกต่างหาก
- ปริมาณประมาณ 1,000 คัน/เดือน (~12,000 ใบเสร็จ/ปี) เก็บรูปประมาณ 1 ปี ≈ 1.8 GB → **อยู่ใน free tier ของ R2** (10 GB/เดือน, ไม่มีค่า egress) จึงเป็นทางเลือกที่ถูกที่สุด
- R2 ใช้ S3 API จึงใช้ไลบรารี `@aws-sdk/client-s3` ได้เลย

## สิ่งที่โค้ดทำ

- ไฟล์หลัก: `backend/src/receipts/receipt-storage.ts`
  - interface `ReceiptStorage` มี `put / get / delete`
  - `LocalReceiptStorage` เก็บที่ `backend/uploads` (dev เท่านั้น, อยู่ใน .gitignore; เปลี่ยนโฟลเดอร์ได้ด้วย `RECEIPT_STORAGE_DIR`)
- key ของไฟล์แยกโฟลเดอร์ตามประเภทรูป ใช้โครงเดียวกันทั้งดิสก์เครื่องและ R2:
  - ใบเสร็จ `receipts/ปี/เดือน/uuid.jpg`
  - ป้ายทะเบียน `plates/ปี/เดือน/uuid.jpg`
  - เล่มทะเบียน `books/ปี/เดือน/uuid.jpg`
  - `R2ReceiptStorage` เก็บบน R2 ผ่าน S3 API (endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, region `auto`)
  - `receiptStorageProvider` เลือกให้อัตโนมัติ: **ตั้ง env R2 ครบ 4 ตัว → ใช้ R2, ว่างทั้ง 4 → ใช้ดิสก์เครื่อง, ตั้งไม่ครบ → backend ไม่ start และแจ้ง error**
- ทั้ง 3 module (receipts, plate-photos, book-photos) ใช้ provider เดียวกัน
- ตารางในฐานข้อมูลเก็บแค่ **key** ของไฟล์ ตัวไฟล์อยู่ใน storage
- Bucket ต้องเป็น **private** หน้าเว็บโหลดรูปผ่าน backend (`GET /api/.../image`) เท่านั้น ไม่เปิด public URL
- เมื่อ backend start จะ log บอกว่าใช้ R2 หรือดิสก์เครื่อง

## ตัวแปร env

| ตัวแปร | หาได้จาก |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare dashboard → R2 → แถบด้านขวา (Account ID) |
| `R2_ACCESS_KEY_ID` | R2 → Manage R2 API Tokens → Create API Token |
| `R2_SECRET_ACCESS_KEY` | ได้พร้อม Access Key ตอนสร้าง token (แสดงครั้งเดียว ต้องคัดลอกเก็บทันที) |
| `R2_BUCKET` | ชื่อ bucket ที่สร้างไว้ (`transport-photos`) |
| `R2_PREFIX` | ไม่บังคับ: โฟลเดอร์ของ environment ใน bucket (ดูด้านล่าง) |

4 ตัวแรกต้องตั้งครบทั้ง 4 หรือว่างทั้ง 4 ตัว ถ้าตั้งไม่ครบ backend จะไม่ start สิทธิ์ของ API token: **Object Read & Write** และ scope ให้เฉพาะ bucket นี้

## Dev กับ Production: bucket เดียว แยกโฟลเดอร์ (ผู้ใช้ตัดสินใจ 2026-09-22)

ใช้ bucket `transport-photos` และ API token ชุดเดิมทั้ง 2 environment แต่แยกไฟล์ด้วย `R2_PREFIX`

| | Dev | Production |
|---|---|---|
| Git branch | `dev` | `master` |
| Render service | `transportation-document-backend-dev` | `transportation-document-backend` |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | ค่าเดิม | **ค่าเดียวกับ dev** |
| `R2_PREFIX` | `DEV` | `production` (ทั้งคู่ตั้งไว้ใน `render.yaml` แล้ว) |
| ไฟล์อยู่ที่ | `DEV/receipts/...`, `DEV/plates/...`, `DEV/books/...` | `production/receipts/...`, `production/plates/...` ฯลฯ |
| สถานะ | ตั้งค่าแล้ว | รอใส่ค่าใน Render |

- prefix ใส่ที่ชั้น storage (`R2ReceiptStorage`) เท่านั้น ฐานข้อมูลยังเก็บ key แบบไม่มี prefix เหมือนเดิม จึงไม่ต้องแก้ข้อมูลหรือ migration
- ชื่อโฟลเดอร์ใน R2 แยกตัวพิมพ์เล็ก/ใหญ่ `DEV` กับ `dev` คือคนละโฟลเดอร์
- ตอนเปลี่ยน dev มาใช้ `DEV/` (2026-09-22) ยังไม่มีรูปที่ root ของ bucket จึงไม่มีไฟล์ต้องย้าย
- `backend/.env` ในเครื่องตั้ง `R2_PREFIX=DEV` ด้วย (ต่อฐานข้อมูล dev เหมือนกัน)
- ข้อควรรู้: token เดียวกันแปลว่า backend dev มีสิทธิ์เขียน/ลบไฟล์ในโฟลเดอร์ `production/` ได้ในทางเทคนิค (โค้ดไม่ทำ เพราะใช้ prefix ต่างกัน) ถ้าวันหนึ่งอยากกันให้ขาด ให้ย้าย production ไป bucket แยกพร้อม token ของตัวเอง
- `render.yaml` ประกาศ `R2_*` ไว้ทั้ง 2 service แล้ว แต่ค่าลับต้องใส่ใน Render dashboard เอง

## ขั้นตอนตั้งค่า Production

1. ทดสอบในเครื่องก่อน: สร้างไฟล์ `backend/.env.production` (อยู่ใน .gitignore แล้ว ไม่ถูก commit) คัดลอก `R2_*` 4 ตัวจาก `backend/.env` แล้วเพิ่ม `R2_PREFIX=production`

   ```bash
   cd backend && node scripts/check-r2.mjs .env.production
   ```

   สคริปต์จะอัปโหลดไฟล์ทดสอบไปที่ `production/_check/...` อ่านกลับ แล้วลบทิ้ง
2. Render → service **`transportation-document-backend`** (ไม่ใช่ `-dev`) → **Environment** → เพิ่ม `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (ค่าเดียวกับ dev) และ `R2_PREFIX` = `production` → **Save only** (ค่าจะมีผลตอน merge `dev` เข้า `master` ครั้งถัดไป)
3. หลัง deploy production ดู log ของ Render ต้องขึ้นว่า `เก็บรูปที่ Cloudflare R2 bucket "transport-photos" โฟลเดอร์ "production"` แล้วลองอัปโหลดรูป 1 รูปบนเว็บ production และเช็กใน Cloudflare ว่ามีไฟล์ในโฟลเดอร์ `production/`

## ข้อควรระวัง

- ห้าม commit ค่า `R2_*` ลง git (ใส่ใน `.env` และ Render Environment เท่านั้น)
- รูปที่ถ่ายไปแล้วตอนยังใช้ดิสก์เครื่อง จะไม่ย้ายขึ้น R2 อัตโนมัติ (ถ้าจะย้ายต้องทำ script อัปโหลดแยก)
- รูปป้ายทะเบียนไม่ถูกลบอัตโนมัติ (ผู้ใช้ตัดสินใจ 2026-09-21) เก็บเป็นหลักฐานผ่าน `Vehicle.platePhotoId`
