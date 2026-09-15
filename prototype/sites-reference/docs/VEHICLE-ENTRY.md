# เพิ่มข้อมูลรถจดใหม่ — Single / Batch

## UI
- Single: date, customerId, chassis, engine, brandId, fuel, cc, weight, color, body, registrationProvince, ownerProvince
- วันที่/ลูกค้า/เลขตัวถัง/ยี่ห้อเป็นช่องบังคับ ช่องอื่นเว้นว่างได้ น้ำหนักเป็นกิโลกรัม
- Dropdown ลูกค้าใช้ตาราง customers และยี่ห้อใช้ตาราง brands; เพิ่มชื่อยี่ห้อจากฟอร์มย่อยได้ ไม่มีข้อมูล seed
- จังหวัดทั้งสองช่องใช้ 77 ชื่อรวมกรุงเทพมหานคร จาก https://std.moc.go.th/std/group/28 (ข้อมูลกรมการปกครองที่เผยแพร่โดยกระทรวงพาณิชย์)
- Single ไม่มีไฟล์แนบ ตามคำตอบผู้ใช้
- Batch รองรับ .xlsx (อ่านชีตแรก) และ CSV UTF-8; สูงสุด 100 รายการ/ไฟล์, 5 MB; ปฏิเสธสูตร Excel
- ดาวน์โหลดหัวตาราง CSV และรายการรหัสลูกค้า/ยี่ห้อได้ คอลัมน์ชื่อยอมรับรหัสได้เพื่อแยกชื่อซ้ำ
- วันที่ Batch ใช้ ค.ศ. YYYY-MM-DD หรือเซลล์วันที่ Excel; ไม่แปลง พ.ศ. อัตโนมัติ
- Preview ตรวจข้อมูลก่อนกดบันทึก แถวผิดต้องแก้ไฟล์และเลือกใหม่; ชุดที่ผิดไม่ถูกบันทึกบางส่วน
- แสดงรถล่าสุด 100 รายการและเปิดรายละเอียดได้ ไม่มีแก้ไข/ลบรถในขอบเขตนี้

## Source / API
- shared/vehicle-data.js: จังหวัด, 12 คอลัมน์ และ validation ที่ใช้ร่วม client/server
- client/vehicles.js: ฟอร์ม, loader, CSV/Excel parser และ batch preview
- server/vehicles.js: GET/POST /api/brands และ GET/POST /api/vehicles
- POST /api/brands รับ {name}; ตอบ {brand:{id,name}}
- POST /api/vehicles รับ {vehicles:[{id,...12 fields}]} ทุก field เป็นข้อความ; id เป็น UUID ใช้ซ้ำเมื่อ retry ข้อมูลเดิมได้
- response สำเร็จ 201 {count}; validation ตอบ {error,errors:[{row,errors}]} row นับจาก 1 ภายใน payload ไม่รวม header ไฟล์; UI แปลงกลับเป็นเลขแถวต้นฉบับ
- GET /api/vehicles คืน {vehicles} โดย SQL ใช้ snake_case และมี customerName/brandName จาก join
- ตาราง vehicles อ้าง foreign key customers/brands; unique chassis; ใช้ D1 batch แบบ atomic
- ไม่มี endpoints ลบข้อมูล ไม่ปรับยอด Dashboard เดิมหรือ workflow งานขั้นถัดไป
- build.mjs ฝัง UI, shared/client JS และ ExcelJS browser bundle เป็น assets ที่ Worker เสิร์ฟเอง
- Migration 0001 เพิ่ม brands/vehicles เท่านั้น ไม่แก้ migration customers ที่ใช้แล้ว

## Validation
ทดสอบฐานข้อมูล SQLite แยก: Single/Batch, rollback เมื่อข้อมูลผิด, ID retry, ตัวถังซ้ำ, วันที่/จังหวัด/ลูกค้าผิด, 77 จังหวัด, รักษาศูนย์นำหน้า
ทดสอบ browser กับฐานทดสอบในหน่วยความจำ: Single save, CSV, XLSX, invalid import ถูกบล็อก, desktop/mobile, ไม่มี page error
ข้อมูลทดสอบไม่ถูกเพิ่มใน production

## ประเภทรถ
เปลี่ยนชื่อช่องจากลักษณะรถเป็นประเภทรถ และใช้ Dropdown 13 ตัวเลือกไม่ซ้ำตามรายการผู้ใช้ โดยคง body เป็น key/column เดิมเพื่อรักษาข้อมูลเก่า ไม่จัดประเภทอัตโนมัติจาก CC
- รย.12-น้อยกว่า 300cc
- รย.12-300-799cc
- รย.12-800-999cc
- รย.12-1000cc ขึ้นไป
- รย.1-เก๋ง 2 ตอน
- รย.1-นั่ง 2 ตอน
- รย.1-นั่ง 3 ตอน
- รย.2-นั่ง 2 แถว
- รย.2-นั่ง 4 ตอน
- รย.3-กระบะบรรทุก
- รย.3-กระบะบรรทุกมีหลังคา
- รย.3-กระบะบรรทุกมีหลังคาแหนบ
- รย.3-ตู้บรรทุก
Single/Batch ตรวจค่าจากรายการเดียวกัน หัวตาราง Batch ใหม่ใช้ประเภทรถ และยังรับหัวตารางเดิมลักษณะรถได้ ข้อมูลเก่าในฐานข้อมูลยังคงเดิม
