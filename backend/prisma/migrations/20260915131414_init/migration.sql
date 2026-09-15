-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'STAFF');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('NEW_REGISTRATION', 'PLATE_SWAP', 'TRANSFER', 'ADDRESS_CHANGE', 'OTHER');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'STAFF',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "idCardNumber" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "plateNumber" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "chassisNumber" TEXT NOT NULL,
    "engineNumber" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "vehicleType" TEXT NOT NULL,
    "registeredAt" TIMESTAMP(3) NOT NULL,
    "currentOwnerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "vehicleId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "assignedStaffId" TEXT,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferDetail" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "fromOwnerId" TEXT NOT NULL,
    "toOwnerId" TEXT NOT NULL,
    "transferDate" TIMESTAMP(3) NOT NULL,
    "price" DECIMAL(12,2),

    CONSTRAINT "TransferDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlateSwapDetail" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "oldPlateNumber" TEXT NOT NULL,
    "newPlateNumber" TEXT NOT NULL,
    "swapDate" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlateSwapDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AddressChangeDetail" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "oldAddress" TEXT NOT NULL,
    "newAddress" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AddressChangeDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseDocument" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_idCardNumber_key" ON "Customer"("idCardNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_plateNumber_key" ON "Vehicle"("plateNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_chassisNumber_key" ON "Vehicle"("chassisNumber");

-- CreateIndex
CREATE INDEX "Vehicle_currentOwnerId_idx" ON "Vehicle"("currentOwnerId");

-- CreateIndex
CREATE UNIQUE INDEX "Case_caseNumber_key" ON "Case"("caseNumber");

-- CreateIndex
CREATE INDEX "Case_vehicleId_idx" ON "Case"("vehicleId");

-- CreateIndex
CREATE INDEX "Case_requesterId_idx" ON "Case"("requesterId");

-- CreateIndex
CREATE INDEX "Case_assignedStaffId_idx" ON "Case"("assignedStaffId");

-- CreateIndex
CREATE INDEX "Case_status_idx" ON "Case"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TransferDetail_caseId_key" ON "TransferDetail"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "PlateSwapDetail_caseId_key" ON "PlateSwapDetail"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "AddressChangeDetail_caseId_key" ON "AddressChangeDetail"("caseId");

-- CreateIndex
CREATE INDEX "CaseDocument_caseId_idx" ON "CaseDocument"("caseId");

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_currentOwnerId_fkey" FOREIGN KEY ("currentOwnerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_assignedStaffId_fkey" FOREIGN KEY ("assignedStaffId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferDetail" ADD CONSTRAINT "TransferDetail_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlateSwapDetail" ADD CONSTRAINT "PlateSwapDetail_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AddressChangeDetail" ADD CONSTRAINT "AddressChangeDetail_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseDocument" ADD CONSTRAINT "CaseDocument_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
