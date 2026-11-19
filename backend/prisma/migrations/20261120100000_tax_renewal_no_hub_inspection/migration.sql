-- ต่อภาษีตามอายุรถ (7 ปี / 5 ปี) ไม่ผ่านคิวตรวจรถของงานรถเก่าแล้ว (ผู้ใช้ 2026-11-20: ตรอ. ไม่เกี่ยวกับตรวจรถในระบบ)
-- ยังตรวจ: รถ ขส. และรถที่ค้างภาษีเกิน 1 ปี
-- งานต่อภาษีที่รับไว้แล้วแต่ยังไม่ยื่น ยังไม่เคยส่งตรวจ ไม่ใช่ ขส. และภาษีไม่ได้ขาดเกิน 1 ปี -> ไม่ต้องตรวจ (ข้อมูลอย่างเดียว ไม่แก้โครงสร้าง)
UPDATE "OldVehicleJob" j
SET "inspectionRequired" = false
FROM "OldVehicle" v
WHERE v."id" = j."vehicleId"
  AND j."jobType" = 'TAX_RENEWAL'
  AND j."jobId" IS NULL
  AND j."cancelledAt" IS NULL
  AND j."inspectionRequired" = true
  AND j."inspectionSentDate" IS NULL
  AND (v."vehicleType" IS NULL OR v."vehicleType" NOT LIKE 'ขส.%')
  AND j."taxExpiryDate" IS NOT NULL
  AND j."taxExpiryDate" >= (CURRENT_DATE - INTERVAL '1 year');
