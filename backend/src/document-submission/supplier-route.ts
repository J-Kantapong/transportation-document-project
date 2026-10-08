// เส้นทางจดทะเบียนตามจังหวัดที่จด (ผู้ใช้กำหนด 2026-10-08) - ตัดสินจาก Vehicle.registrationProvince อย่างเดียว:
// - กรุงเทพมหานคร: ตัดบัญชี แล้วออฟฟิศตรวจรถ + ยื่นเอง
// - สมุทรปราการ: แจ้งย้าย แล้วออฟฟิศตรวจรถ + ยื่นเอง
// - จังหวัดอื่นทุกจังหวัด: ออฟฟิศแจ้งย้ายก่อน (ขั้น 2) แล้วส่งให้ซับ (Supplier) จดให้ทั้งหมด - ซับตรวจรถ ยื่น จ่ายค่าธรรมเนียม
//   ราชการแทน และรับใบเสร็จ/ป้าย/เล่มกลับมาให้ จึงไม่เข้าคิวตรวจรถของออฟฟิศ: ขั้น 4 ของรถกลุ่มนี้ = "ส่งงานให้ซับ"
//   (DocumentSubmission.viaSupplier) แล้วเดินขั้น 5-8 ตามปกติเมื่อของกลับมา
// ค่าจ้างซับคิดตามตารางราคาต่อจังหวัดเสมอ (SupplierProvinceRate) = ค่าดำเนินการ + ค่าช่อง + นำรถเข้าตรวจสภาพ คิดทุกคัน
// เก็บเป็น No bill ของรายการยื่น (ต้นทุน - ไม่ขึ้นใบวางบิล ราคาขายเป็นตารางราคาลูกค้าแยกต่างหาก)
// frontend/src/lib/supplier-route.ts ต้องตรงกับไฟล์นี้
import type { Prisma } from '../generated/prisma/client.js';
import type { FeeItem } from './document-fee-calculator.js';

export const SELF_REGISTER_PROVINCES = ['กรุงเทพมหานคร', 'สมุทรปราการ'];

export function isSupplierProvince(registrationProvince: string | null | undefined): boolean {
  return !!registrationProvince && !SELF_REGISTER_PROVINCES.includes(registrationProvince);
}

// where ของรถที่ส่งซับจด - ใช้กับ NOT เพื่อกันรถกลุ่มนี้ออกจากคิวตรวจรถ
export const SUPPLIER_VEHICLE_WHERE = {
  AND: [{ registrationProvince: { not: null } }, { registrationProvince: { notIn: SELF_REGISTER_PROVINCES } }],
} satisfies Prisma.VehicleWhereInput;

export interface SupplierRateRow {
  province: string;
  accepts: boolean; // false = ซับไม่รับจดจังหวัดนี้
  serviceFee: number | null; // ค่าดำเนินการ
  channelFee: number | null; // ค่าช่อง
  inspectionFee: number | null; // นำรถเข้าตรวจสภาพ
}

export const SUPPLIER_FEE_LABELS = {
  serviceFee: 'ค่าดำเนินการซับ',
  channelFee: 'ค่าช่อง',
  inspectionFee: 'นำรถเข้าตรวจสภาพ',
} as const;
export type SupplierFeeKey = keyof typeof SUPPLIER_FEE_LABELS;
export const SUPPLIER_FEE_KEYS = Object.keys(SUPPLIER_FEE_LABELS) as SupplierFeeKey[];

// รายการ No bill ของรถที่ส่งซับ = ค่าจ้างซับตามตารางของจังหวัดที่จด - ไม่มีราคา/ซับไม่รับ = ยื่นไม่ได้ (ไม่เดาราคาให้)
export function supplierFeeItems(province: string, rates: SupplierRateRow[] | undefined): FeeItem[] {
  const rate = rates?.find((r) => r.province === province);
  if (!rate) throw new Error(`ยังไม่มีราคาซับของจังหวัด${province} - ให้ผู้ดูแลระบบตั้งราคาที่หน้า "ราคาซับจดต่างจังหวัด" ก่อน`);
  if (!rate.accepts) throw new Error(`ซับไม่รับจดทะเบียนจังหวัด${province}`);
  return SUPPLIER_FEE_KEYS.map((key) => {
    const amount = rate[key];
    if (amount === null) throw new Error(`ราคาซับของจังหวัด${province} ยังไม่ครบ (${SUPPLIER_FEE_LABELS[key]})`);
    return { label: SUPPLIER_FEE_LABELS[key], amount };
  });
}

// รถที่ส่งซับจดไม่มี "งานด่วน" และ "หยุดใช้ย้ายออก" (ผู้ใช้ 2026-10-08: ไม่ต้องมี) - ตัวเลือกสองตัวนี้เป็นของงานที่ออฟฟิศยื่นเอง
// หน้าจอซ่อนไว้แล้ว ตรงนี้กันค่าที่ส่งมาตรงๆ: ไม่เก็บลงรายการยื่น จึงไม่ไปติดค่าบริการ "ด่วน" ตอนวางบิลด้วย
export function withoutOfficeOnlyOptions<T extends { urgent: boolean; stopUseRelocateOut: boolean }>(options: T, registrationProvince: string | null | undefined): T {
  return isSupplierProvince(registrationProvince) ? { ...options, urgent: false, stopUseRelocateOut: false } : options;
}
