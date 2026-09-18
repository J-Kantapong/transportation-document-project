-- Tax rule governance (DRAFT/VERIFIED + active) on the existing GovernmentTax* tables, plus
-- a new VehicleOwner (separate from Customer - never infer owner from the requesting
-- customer) and an immutable TaxCalculation snapshot per computed result. See the comment
-- block above GovernmentTaxCcBracket in schema.prisma for the DRAFT/VERIFIED policy.

-- CreateEnum
CREATE TYPE "GovTaxRuleStatus" AS ENUM ('DRAFT', 'VERIFIED');

-- CreateEnum
CREATE TYPE "OwnerType" AS ENUM ('INDIVIDUAL', 'JURISTIC');

-- AlterTable: governance columns default to DRAFT/inactive everywhere - a row someone adds
-- later can never silently compute a real tax figure until explicitly flipped to VERIFIED.
ALTER TABLE "GovernmentTaxCcBracket"
  ADD COLUMN "status" "GovTaxRuleStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "legalReference" TEXT;

-- AlterTable
ALTER TABLE "GovernmentTaxWeightBracket"
  ADD COLUMN "status" "GovTaxRuleStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "legalReference" TEXT;

-- AlterTable
ALTER TABLE "GovernmentTaxEvIncentive"
  ADD COLUMN "status" "GovTaxRuleStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "legalReference" TEXT;

-- AlterTable
ALTER TABLE "GovernmentTaxMotorcycleFlat"
  ADD COLUMN "status" "GovTaxRuleStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "legalReference" TEXT;

-- CreateTable
CREATE TABLE "VehicleOwner" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "ownerType" "OwnerType" NOT NULL,
    "isHirePurchaseBusiness" BOOLEAN NOT NULL DEFAULT false,
    "hirerType" "OwnerType",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleOwner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxCalculation" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "vehicleFamily" "GovTaxVehicleFamily",
    "fuelGroup" "GovTaxFuelGroup",
    "baseAmount" DECIMAL(12,2),
    "incentiveDiscountPercent" DECIMAL(5,2),
    "juristicMultiplier" INTEGER NOT NULL DEFAULT 1,
    "finalAmount" DECIMAL(12,2),
    "reason" TEXT,
    "inputSnapshot" JSONB NOT NULL,
    "breakdown" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxCalculation_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Vehicle"
  ADD COLUMN "isFactoryNew" BOOLEAN,
  ADD COLUMN "ownerId" TEXT;

-- CreateIndex
CREATE INDEX "Vehicle_ownerId_idx" ON "Vehicle"("ownerId");

-- CreateIndex
CREATE INDEX "TaxCalculation_vehicleId_idx" ON "TaxCalculation"("vehicleId");

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "VehicleOwner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxCalculation" ADD CONSTRAINT "TaxCalculation_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data step: mark the rate rows the user already confirmed as VERIFIED + active. RY1
-- ICE/HEV/PHEV cc brackets (0-600@0.5, 600-1800@1.5, 1800+@4 บาท/cc) and the RY12 ICE flat
-- rate (100 บาท/ปี) were confirmed in conversation earlier this session; everything else
-- (weight brackets, EV incentive, RY12 BEV) stays DRAFT/inactive until the user supplies it.
UPDATE "GovernmentTaxCcBracket"
  SET "status" = 'VERIFIED', "active" = true
  WHERE "vehicleFamily" = 'RY1' AND "fuelGroup" IN ('ICE', 'HEV', 'PHEV');

UPDATE "GovernmentTaxMotorcycleFlat"
  SET "status" = 'VERIFIED', "active" = true
  WHERE "fuelGroup" = 'ICE' AND "amount" IS NOT NULL;
