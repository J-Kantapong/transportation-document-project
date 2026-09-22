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

## ตัวแปร env (ต้องตั้งครบทั้ง 4 ตัว หรือว่างทั้ง 4 ตัว)

| ตัวแปร | หาได้จาก |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare dashboard → R2 → แถบด้านขวา (Account ID) |
| `R2_ACCESS_KEY_ID` | R2 → Manage R2 API Tokens → Create API Token |
| `R2_SECRET_ACCESS_KEY` | ได้พร้อม Access Key ตอนสร้าง token (แสดงครั้งเดียว ต้องคัดลอกเก็บทันที) |
| `R2_BUCKET` | ชื่อ bucket ที่สร้างไว้ |

สิทธิ์ของ API token: **Object Read & Write** และ scope ให้เฉพาะ bucket นี้

## ขั้นตอนตั้งค่า (ยังไม่ได้ทำ – รอผู้ใช้)

1. Cloudflare dashboard → R2 → **Create bucket** (ตั้งชื่อ เช่น `transportation-photos`) ไม่ต้องเปิด public access
2. R2 → **Manage R2 API Tokens** → Create API Token → permission Object Read & Write → เลือก bucket → คัดลอก Access Key ID และ Secret Access Key
3. ทดสอบในเครื่อง: ใส่ค่าทั้ง 4 ใน `backend/.env` แล้วรัน

   ```bash
   cd backend && node scripts/check-r2.mjs
   ```

   สคริปต์จะอัปโหลดไฟล์ทดสอบ อ่านกลับ แล้วลบทิ้ง และบอกสาเหตุถ้าเชื่อมต่อไม่ได้ (key ผิด / ชื่อ bucket ผิด / token ไม่มีสิทธิ์)
4. Render (production) → service backend → **Environment** → เพิ่มตัวแปรทั้ง 4 → redeploy
5. Dev environment: ปล่อย `R2_*` ว่างไว้ให้เก็บบนดิสก์ Render (หายทุก deploy ซึ่งยอมรับได้สำหรับ dev) หรือถ้าต้องการให้รูปคงอยู่ ให้สร้าง bucket แยกชื่อลงท้าย `-dev`

## ข้อควรระวัง

- ห้าม commit ค่า `R2_*` ลง git (ใส่ใน `.env` และ Render Environment เท่านั้น)
- รูปที่ถ่ายไปแล้วตอนยังใช้ดิสก์เครื่อง จะไม่ย้ายขึ้น R2 อัตโนมัติ (ถ้าจะย้ายต้องทำ script อัปโหลดแยก)
- รูปป้ายทะเบียนไม่ถูกลบอัตโนมัติ (ผู้ใช้ตัดสินใจ 2026-09-21) เก็บเป็นหลักฐานผ่าน `Vehicle.platePhotoId`
