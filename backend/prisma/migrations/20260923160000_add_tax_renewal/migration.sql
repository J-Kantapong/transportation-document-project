-- CreateTable
CREATE TABLE "TaxRenewal" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT,
    "customerId" TEXT,
    "plateCategory" TEXT NOT NULL,
    "plateNumber" TEXT NOT NULL,
    "registrationProvince" TEXT,
    "vehicleType" TEXT NOT NULL,
    "fuel" TEXT NOT NULL,
    "cc" DECIMAL(10,2),
    "weight" DECIMAL(10,2),
    "firstRegistrationDate" TIMESTAMP(3) NOT NULL,
    "ownerType" "OwnerType" NOT NULL,
    "ownerName" TEXT,
    "taxExpiryDate" TIMESTAMP(3) NOT NULL,
    "inspectionRequired" BOOLEAN NOT NULL DEFAULT false,
    "inspectionConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "insuranceConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "paymentDate" TIMESTAMP(3),
    "skipContribution" BOOLEAN NOT NULL DEFAULT false,
    "billItems" JSONB,
    "noBillItems" JSONB,
    "billTotal" DECIMAL(12,2),
    "noBillTotal" DECIMAL(12,2),
    "taxBreakdown" JSONB,
    "receivedDate" TIMESTAMP(3),
    "deliveredDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxRenewal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxRenewal_vehicleId_idx" ON "TaxRenewal"("vehicleId");

-- CreateIndex
CREATE INDEX "TaxRenewal_customerId_idx" ON "TaxRenewal"("customerId");

-- CreateIndex
CREATE INDEX "TaxRenewal_taxExpiryDate_idx" ON "TaxRenewal"("taxExpiryDate");

-- CreateIndex
CREATE INDEX "TaxRenewal_paymentDate_idx" ON "TaxRenewal"("paymentDate");

-- AddForeignKey
ALTER TABLE "TaxRenewal" ADD CONSTRAINT "TaxRenewal_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxRenewal" ADD CONSTRAINT "TaxRenewal_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
