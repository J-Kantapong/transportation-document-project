-- Rename FeeAccountCutoff -> FeeDeregistration and FeeAddressChange -> FeeRelocate,
-- including their primary key constraint and unique index, to match the renamed
-- Prisma models. Table renames preserve existing data.

ALTER TABLE "FeeAccountCutoff" RENAME TO "FeeDeregistration";
ALTER TABLE "FeeDeregistration" RENAME CONSTRAINT "FeeAccountCutoff_pkey" TO "FeeDeregistration_pkey";
ALTER INDEX "FeeAccountCutoff_vehicleType_brand_key" RENAME TO "FeeDeregistration_vehicleType_brand_key";

ALTER TABLE "FeeAddressChange" RENAME TO "FeeRelocate";
ALTER TABLE "FeeRelocate" RENAME CONSTRAINT "FeeAddressChange_pkey" TO "FeeRelocate_pkey";
ALTER INDEX "FeeAddressChange_vehicleType_brand_key" RENAME TO "FeeRelocate_vehicleType_brand_key";
