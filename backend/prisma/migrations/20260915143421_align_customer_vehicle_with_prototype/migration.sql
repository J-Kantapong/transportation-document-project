-- DropForeignKey
ALTER TABLE "Vehicle" DROP CONSTRAINT "Vehicle_currentOwnerId_fkey";

-- DropIndex
DROP INDEX "Customer_idCardNumber_key";

-- DropIndex
DROP INDEX "Vehicle_chassisNumber_key";

-- DropIndex
DROP INDEX "Vehicle_currentOwnerId_idx";

-- DropIndex
DROP INDEX "Vehicle_plateNumber_key";

-- AlterTable
ALTER TABLE "Customer" DROP COLUMN "fullName",
DROP COLUMN "idCardNumber",
ADD COLUMN     "branch" TEXT,
ADD COLUMN     "company" TEXT,
ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "taxId" TEXT,
ALTER COLUMN "address" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Vehicle" DROP COLUMN "brand",
DROP COLUMN "chassisNumber",
DROP COLUMN "currentOwnerId",
DROP COLUMN "engineNumber",
DROP COLUMN "model",
DROP COLUMN "plateNumber",
DROP COLUMN "province",
DROP COLUMN "registeredAt",
DROP COLUMN "vehicleType",
ADD COLUMN     "body" TEXT,
ADD COLUMN     "brandId" TEXT NOT NULL,
ADD COLUMN     "cc" DECIMAL(10,2),
ADD COLUMN     "chassis" TEXT NOT NULL,
ADD COLUMN     "customerId" TEXT NOT NULL,
ADD COLUMN     "date" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "engine" TEXT,
ADD COLUMN     "fuel" TEXT,
ADD COLUMN     "ownerProvince" TEXT,
ADD COLUMN     "registrationProvince" TEXT,
ADD COLUMN     "weight" DECIMAL(10,2),
ALTER COLUMN "color" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Brand_name_key" ON "Brand"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_chassis_key" ON "Vehicle"("chassis");

-- CreateIndex
CREATE INDEX "Vehicle_customerId_idx" ON "Vehicle"("customerId");

-- CreateIndex
CREATE INDEX "Vehicle_brandId_idx" ON "Vehicle"("brandId");

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

