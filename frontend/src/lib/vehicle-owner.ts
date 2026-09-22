// เจ้าของรถจากหน้าเพิ่มข้อมูลรถจดใหม่ (ประเภทเจ้าของรถ + ไฟแนนซ์) - ดู backend/src/vehicles/vehicles.service.ts ownerDataFor
// ติ๊กไฟแนนซ์แล้ว ไฟแนนซ์เป็นเจ้าของตามทะเบียน (ownerType = JURISTIC) ส่วนบุคคลธรรมดา/นิติบุคคลที่ผู้ใช้เลือกอยู่ที่ hirerType
// หน้าจอทุกหน้าควรแสดง "ประเภทที่ผู้ใช้เลือก" ไม่ใช่ ownerType ดิบ จึงรวม helper ไว้ที่นี่ที่เดียว
import type { OwnerType } from "@/lib/api";
import { OWNER_TYPES } from "@/lib/vehicle-reference-data";

export const OWNER_TYPE_LABEL: Record<OwnerType, string> = Object.fromEntries(OWNER_TYPES) as Record<OwnerType, string>;

export interface OwnerLike {
  ownerType: OwnerType | null;
  hirerType: OwnerType | null;
  financeCompanyId: string | null;
}

// ประเภทที่ผู้ใช้เลือกในหน้าเพิ่มข้อมูลรถ (บุคคลธรรมดา/นิติบุคคล) - มีไฟแนนซ์ = ผู้เช่าซื้อ ไม่มี = เจ้าของเอง
export function entryOwnerType(owner: OwnerLike | null | undefined): OwnerType | null {
  if (!owner?.ownerType) return null;
  return owner.financeCompanyId ? owner.hirerType : owner.ownerType;
}

// ข้อความแสดงผล เช่น "บุคคลธรรมดา" หรือ "บุคคลธรรมดา · ไฟแนนซ์ กรุงศรี" (financeName แยกส่งมาเพราะแต่ละ API ตั้งชื่อต่างกัน)
export function ownerDisplayLabel(owner: OwnerLike | null | undefined, financeName: string | null | undefined): string | null {
  const type = entryOwnerType(owner);
  if (!type) return null;
  const label = OWNER_TYPE_LABEL[type];
  return owner?.financeCompanyId ? `${label} · ไฟแนนซ์ ${financeName ?? ""}`.trim() : label;
}
