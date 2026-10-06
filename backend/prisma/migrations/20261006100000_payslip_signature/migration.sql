-- ผู้ใช้ 2026-10-06: ลายเซ็นผู้จ่ายเงินบนสลิปเงินเดือน (ตารางใหม่ ไม่แตะข้อมูลเดิม)
-- CreateTable
CREATE TABLE "PayslipSignature" (
    "id" TEXT NOT NULL DEFAULT 'payer',
    "signerName" TEXT,
    "image" BYTEA NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'image/png',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByName" TEXT,

    CONSTRAINT "PayslipSignature_pkey" PRIMARY KEY ("id")
);
