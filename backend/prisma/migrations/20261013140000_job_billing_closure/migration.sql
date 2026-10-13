-- ปิดงาน - วางบิลนอกระบบ ของงานอื่นๆ (เพิ่มตารางใหม่อย่างเดียว)
CREATE TABLE "JobBillingClosure" (
    "id" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedById" TEXT,

    CONSTRAINT "JobBillingClosure_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JobBillingClosure_jobType_jobId_key" ON "JobBillingClosure"("jobType", "jobId");
CREATE INDEX "JobBillingClosure_closedAt_idx" ON "JobBillingClosure"("closedAt");

ALTER TABLE "JobBillingClosure" ADD CONSTRAINT "JobBillingClosure_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
