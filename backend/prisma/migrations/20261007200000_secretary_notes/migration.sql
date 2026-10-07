-- ผู้ใช้ 2026-10-07: ตู้ข้อความของเลขาส่วนตัว (จำ/ขอ/ลืมผ่านไลน์) - เพิ่มตารางใหม่เท่านั้น ไม่แตะข้อมูลเดิม

-- CreateTable
CREATE TABLE "SecretaryNote" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecretaryNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SecretaryNote_key_key" ON "SecretaryNote"("key");
