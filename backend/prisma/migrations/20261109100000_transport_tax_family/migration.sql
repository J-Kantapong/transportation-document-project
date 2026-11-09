-- รถตาม พ.ร.บ.การขนส่งทางบก (งานต่อภาษีรถใหญ่, ผู้ใช้ 2026-11-09) - additive only
-- เพิ่มค่าใน enum อย่างเดียว: Postgres ไม่ให้ใช้ค่า enum ใหม่ใน transaction เดียวกับ ALTER TYPE ... ADD VALUE
-- แถวอัตราภาษีและคอลัมน์ TaxRenewal อยู่ใน migration ถัดไป (20261109110000_tax_renewal_transport)
ALTER TYPE "GovTaxVehicleFamily" ADD VALUE 'TRANSPORT_PRIVATE';
ALTER TYPE "GovTaxVehicleFamily" ADD VALUE 'TRANSPORT_NON_FIXED';
ALTER TYPE "GovTaxVehicleFamily" ADD VALUE 'TRANSPORT_FIXED';
ALTER TYPE "GovTaxVehicleFamily" ADD VALUE 'TRANSPORT_SMALL';
