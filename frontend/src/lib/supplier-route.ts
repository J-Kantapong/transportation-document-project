// เส้นทางจดทะเบียนตามจังหวัดที่จด (ผู้ใช้ 2026-10-08) - สำเนาของ backend/src/document-submission/supplier-route.ts แก้ให้ตรงกัน
// กรุงเทพมหานคร / สมุทรปราการ = ออฟฟิศจดเอง · จังหวัดอื่น = ออฟฟิศแจ้งย้ายก่อน แล้วส่งซับ (Supplier) จดให้ทั้งหมด
// (ไม่ผ่านคิวตรวจรถของออฟฟิศ ขั้นยื่นเอกสาร = ส่งงานให้ซับ ค่าจ้างซับคิดตามตารางราคาต่อจังหวัด)
export const SELF_REGISTER_PROVINCES = ["กรุงเทพมหานคร", "สมุทรปราการ"];

export function isSupplierProvince(registrationProvince: string | null | undefined): boolean {
  return !!registrationProvince && !SELF_REGISTER_PROVINCES.includes(registrationProvince);
}

// ป้ายรายการ No bill ของรายการที่ส่งซับ (ลำดับเดียวกับ backend) - ใช้แยกยอด 3 ช่องตอนแก้ค่าจ้างซับ
export const SUPPLIER_FEE_FIELDS = [
  { key: "serviceFee", label: "ค่าดำเนินการซับ" },
  { key: "channelFee", label: "ค่าช่อง" },
  { key: "inspectionFee", label: "นำรถเข้าตรวจสภาพ" },
] as const;
export type SupplierFeeKey = (typeof SUPPLIER_FEE_FIELDS)[number]["key"];
