-- งานรถเก่า: รับงาน -> ตรวจรถ -> ยื่น (ผู้ใช้ 2026-11-18)
-- ตารางใหม่ 2 ตาราง เพิ่มอย่างเดียว ไม่แตะตารางงานเดิม: OldVehicle (รถเก่า 1 คัน) + OldVehicleJob (การรับงาน 1 ครั้ง)
-- แถวของงานเดิมถูกสร้างย้อนหลังโดยระบบเมื่อเปิดหน้ารวม (OldVehicleJobsService.sync) ไม่ได้ทำใน migration
CREATE TABLE "OldVehicle" (
    "id" TEXT NOT NULL,
    "vehicleType" TEXT,
    "vehicleClass" TEXT NOT NULL DEFAULT 'CAR',
    "plateCategory" TEXT NOT NULL,
    "plateNumber" TEXT NOT NULL,
    "chassis" TEXT NOT NULL,
    "chassisKey" TEXT NOT NULL,
    "engine" TEXT,
    "brand" TEXT,
    "ownerName" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OldVehicle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OldVehicleJob" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "customerId" TEXT,
    "receivedDate" TIMESTAMP(3) NOT NULL,
    "receivedIsBackfill" BOOLEAN NOT NULL DEFAULT false,
    "jobType" TEXT,
    "jobId" TEXT,
    "note" TEXT,
    "duplicateReason" TEXT,
    "firstRegistrationDate" TIMESTAMP(3),
    "taxExpiryDate" TIMESTAMP(3),
    "inspectionRequired" BOOLEAN NOT NULL DEFAULT false,
    "inspectionSentType" TEXT,
    "inspectionSentDate" TIMESTAMP(3),
    "inspectionCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "inspectionResult" TEXT,
    "inspectionResultDate" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "blockedReason" TEXT,
    "blockedNote" TEXT,
    "blockedById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelledById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OldVehicleJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OldVehicle_chassisKey_key" ON "OldVehicle"("chassisKey");
CREATE INDEX "OldVehicle_plateCategory_plateNumber_idx" ON "OldVehicle"("plateCategory", "plateNumber");

CREATE UNIQUE INDEX "OldVehicleJob_jobType_jobId_key" ON "OldVehicleJob"("jobType", "jobId");
CREATE INDEX "OldVehicleJob_vehicleId_idx" ON "OldVehicleJob"("vehicleId");
CREATE INDEX "OldVehicleJob_customerId_idx" ON "OldVehicleJob"("customerId");
CREATE INDEX "OldVehicleJob_receivedDate_idx" ON "OldVehicleJob"("receivedDate");
CREATE INDEX "OldVehicleJob_blockedAt_idx" ON "OldVehicleJob"("blockedAt");

ALTER TABLE "OldVehicleJob" ADD CONSTRAINT "OldVehicleJob_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "OldVehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OldVehicleJob" ADD CONSTRAINT "OldVehicleJob_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
