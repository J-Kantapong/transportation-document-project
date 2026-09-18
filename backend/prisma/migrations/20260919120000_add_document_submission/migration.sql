-- Step 4 (ยื่นเอกสารจดทะเบียนรถใหม่): mutable plateCategory/plateNumber on Vehicle (filled in
-- whenever known - the DLT may assign the plate number later, after the receipt is issued),
-- plus an immutable DocumentSubmission snapshot per submission, mirroring TaxCalculation's
-- audit-trail pattern. See the comment block above DocumentSubmission in schema.prisma.

-- AlterTable
ALTER TABLE "Vehicle"
  ADD COLUMN "plateCategory" TEXT,
  ADD COLUMN "plateNumber" TEXT;

-- CreateTable
CREATE TABLE "DocumentSubmission" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "submitDate" TIMESTAMP(3) NOT NULL,
    "plateNumberOption" TEXT NOT NULL,
    "includePlateFee" BOOLEAN NOT NULL DEFAULT true,
    "newPlateOption" TEXT,
    "relocateAddon" BOOLEAN NOT NULL DEFAULT false,
    "stopUseRelocateOut" BOOLEAN NOT NULL DEFAULT false,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "billItems" JSONB NOT NULL,
    "noBillItems" JSONB NOT NULL,
    "billFeeTotal" DECIMAL(12,2) NOT NULL,
    "noBillTotal" DECIMAL(12,2) NOT NULL,
    "taxAmount" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentSubmission_vehicleId_idx" ON "DocumentSubmission"("vehicleId");

-- CreateIndex
CREATE INDEX "DocumentSubmission_submitDate_idx" ON "DocumentSubmission"("submitDate");

-- AddForeignKey
ALTER TABLE "DocumentSubmission" ADD CONSTRAINT "DocumentSubmission_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
