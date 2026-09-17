-- CreateEnum
CREATE TYPE "YamahaRelocationSize" AS ENUM ('SMALL', 'LARGE');

-- CreateTable
CREATE TABLE "YamahaRelocationEntry" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "size" "YamahaRelocationSize" NOT NULL,
    "billCount" INTEGER NOT NULL DEFAULT 0,
    "noBillCount" INTEGER NOT NULL DEFAULT 0,
    "billFee" DECIMAL(10,2) NOT NULL,
    "noBillFee" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YamahaRelocationEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "YamahaRelocationEntry_size_date_idx" ON "YamahaRelocationEntry"("size", "date");
