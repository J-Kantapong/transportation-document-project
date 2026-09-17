-- Government annual vehicle tax (ภาษีรถประจำปี) tables, kept separate from the Fee*
-- (company/registration filing fee) tables. See schema.prisma comment above these models.

-- CreateEnum
CREATE TYPE "GovTaxVehicleFamily" AS ENUM ('RY1', 'RY2', 'RY3', 'RY12');

-- CreateEnum
CREATE TYPE "GovTaxFuelGroup" AS ENUM ('ICE', 'HEV', 'PHEV', 'BEV');

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "firstRegistrationDate" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "GovernmentTaxCcBracket" (
    "id" TEXT NOT NULL,
    "vehicleFamily" "GovTaxVehicleFamily" NOT NULL,
    "fuelGroup" "GovTaxFuelGroup" NOT NULL,
    "ccFrom" DECIMAL(10,2) NOT NULL,
    "ccTo" DECIMAL(10,2),
    "ratePerCc" DECIMAL(10,4) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "GovernmentTaxCcBracket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GovernmentTaxWeightBracket" (
    "id" TEXT NOT NULL,
    "vehicleFamily" "GovTaxVehicleFamily" NOT NULL,
    "fuelGroup" "GovTaxFuelGroup",
    "weightFrom" DECIMAL(10,2) NOT NULL,
    "weightTo" DECIMAL(10,2),
    "amount" DECIMAL(10,2),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "GovernmentTaxWeightBracket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GovernmentTaxEvIncentive" (
    "id" TEXT NOT NULL,
    "vehicleFamily" "GovTaxVehicleFamily" NOT NULL,
    "label" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "discountPercent" DECIMAL(5,2),
    "note" TEXT,

    CONSTRAINT "GovernmentTaxEvIncentive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GovernmentTaxMotorcycleFlat" (
    "id" TEXT NOT NULL,
    "fuelGroup" "GovTaxFuelGroup" NOT NULL,
    "amount" DECIMAL(10,2),
    "note" TEXT,

    CONSTRAINT "GovernmentTaxMotorcycleFlat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GovernmentTaxCcBracket_vehicleFamily_fuelGroup_ccFrom_key" ON "GovernmentTaxCcBracket"("vehicleFamily", "fuelGroup", "ccFrom");

-- CreateIndex
CREATE UNIQUE INDEX "GovernmentTaxWeightBracket_vehicleFamily_fuelGroup_weightF_key" ON "GovernmentTaxWeightBracket"("vehicleFamily", "fuelGroup", "weightFrom");

-- CreateIndex
CREATE UNIQUE INDEX "GovernmentTaxMotorcycleFlat_fuelGroup_key" ON "GovernmentTaxMotorcycleFlat"("fuelGroup");
