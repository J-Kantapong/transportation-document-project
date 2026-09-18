-- CreateTable
CREATE TABLE "FeeAccountCutoff" (
    "id" TEXT NOT NULL,
    "vehicleType" TEXT NOT NULL,
    "brand" TEXT NOT NULL DEFAULT 'อื่นๆ',
    "amount" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "FeeAccountCutoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeAddressChange" (
    "id" TEXT NOT NULL,
    "vehicleType" TEXT NOT NULL,
    "brand" TEXT NOT NULL DEFAULT 'อื่นๆ',
    "noBillAmount" DECIMAL(10,2) NOT NULL,
    "billAmount" DECIMAL(10,2) NOT NULL DEFAULT 5,

    CONSTRAINT "FeeAddressChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeInspectionBangkok" (
    "id" TEXT NOT NULL,
    "vehicleType" TEXT NOT NULL,
    "brand" TEXT NOT NULL DEFAULT 'อื่นๆ',
    "amount" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "FeeInspectionBangkok_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeInspectionProvince" (
    "id" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "vehicleType" TEXT NOT NULL,
    "amount" DECIMAL(10,2),

    CONSTRAINT "FeeInspectionProvince_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeCarBillParam" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "amount" DECIMAL(10,2),
    "note" TEXT,

    CONSTRAINT "FeeCarBillParam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeCarNoBillParam" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "amount" DECIMAL(10,2),
    "note" TEXT,

    CONSTRAINT "FeeCarNoBillParam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeMotorcycleBillParam" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "amount" DECIMAL(10,2),
    "note" TEXT,

    CONSTRAINT "FeeMotorcycleBillParam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeMotorcycleNoBillParam" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "amount" DECIMAL(10,2),
    "note" TEXT,

    CONSTRAINT "FeeMotorcycleNoBillParam_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FeeAccountCutoff_vehicleType_brand_key" ON "FeeAccountCutoff"("vehicleType", "brand");

-- CreateIndex
CREATE UNIQUE INDEX "FeeAddressChange_vehicleType_brand_key" ON "FeeAddressChange"("vehicleType", "brand");

-- CreateIndex
CREATE UNIQUE INDEX "FeeInspectionBangkok_vehicleType_brand_key" ON "FeeInspectionBangkok"("vehicleType", "brand");

-- CreateIndex
CREATE UNIQUE INDEX "FeeInspectionProvince_province_vehicleType_key" ON "FeeInspectionProvince"("province", "vehicleType");

-- CreateIndex
CREATE UNIQUE INDEX "FeeCarBillParam_key_key" ON "FeeCarBillParam"("key");

-- CreateIndex
CREATE UNIQUE INDEX "FeeCarNoBillParam_key_key" ON "FeeCarNoBillParam"("key");

-- CreateIndex
CREATE UNIQUE INDEX "FeeMotorcycleBillParam_key_key" ON "FeeMotorcycleBillParam"("key");

-- CreateIndex
CREATE UNIQUE INDEX "FeeMotorcycleNoBillParam_key_key" ON "FeeMotorcycleNoBillParam"("key");
