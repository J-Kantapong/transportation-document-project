-- งานโอนที่มีขั้นตรวจรถ (โอนตรวจรถ / โอนย้ายเข้า): เลือกแบบการตรวจตอนบันทึกส่งตรวจ + ค่าตรวจรถ (ผู้ใช้ 2026-11-18)
-- inspectionSentType = OUTSIDE (ส่งตรวจนอก พนักงานกรอกค่าตรวจเอง) | BRING_IN (นำรถมาตรวจ ไม่มีค่าตรวจ) / null = งานก่อนมีช่องนี้หรือยังไม่ส่งตรวจ
-- inspectionCost = ค่าตรวจรถ (No Bill) เก็บแยก ไม่รวมใน noBillTotal - เพิ่มคอลัมน์อย่างเดียว งานเดิมไม่เปลี่ยน
ALTER TABLE "VehicleTransfer" ADD COLUMN "inspectionSentType" TEXT;
ALTER TABLE "VehicleTransfer" ADD COLUMN "inspectionCost" DECIMAL(12,2) NOT NULL DEFAULT 0;
