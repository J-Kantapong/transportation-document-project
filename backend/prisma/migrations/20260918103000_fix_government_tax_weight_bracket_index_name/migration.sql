-- The CreateUniqueIndex in 20260918100000_add_government_tax_rules used a truncated name
-- ("...weightF_key") that doesn't match Prisma's current name for this @@unique
-- ("...weightFr_key"). Align the index name with the schema so future `migrate dev` runs
-- stop trying to rename it.

ALTER INDEX "GovernmentTaxWeightBracket_vehicleFamily_fuelGroup_weightF_key" RENAME TO "GovernmentTaxWeightBracket_vehicleFamily_fuelGroup_weightFr_key";
