-- CreateTable
CREATE TABLE "VehicleEditLog" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "remark" TEXT NOT NULL,
    "changes" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleEditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VehicleEditLog_vehicleId_idx" ON "VehicleEditLog"("vehicleId");

-- AddForeignKey
ALTER TABLE "VehicleEditLog" ADD CONSTRAINT "VehicleEditLog_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
