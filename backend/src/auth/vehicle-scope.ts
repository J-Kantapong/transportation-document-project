import { ForbiddenException } from '@nestjs/common';
import type { UserRole } from '../generated/prisma/enums.js';
import { currentUser } from './request-context.js';

// ขอบเขตประเภทรถของขั้น 4-8 (ยื่นเอกสาร -> Delivery) ตามบทบาท (ผู้ใช้ 2026-09-22):
// STAFF_CAR เห็น/แก้เฉพาะรถยนต์, STAFF_MOTO เฉพาะจักรยานยนต์, ถือทั้งคู่หรือ ADMIN/ACCOUNTANT/DELIVERY = ทุกคัน
// ประเภทรถดูจาก Vehicle.body ขึ้นต้น "รย.12-" = จักรยานยนต์ (กฎเดียวกับ document-fee-calculator.isMotorcycle
// และ frontend PlatePhotoPanel.isMotorcycleBody) - body ว่างนับเป็นรถยนต์
export type VehicleKind = 'car' | 'moto';
export type VehicleScope = 'ALL' | 'CAR' | 'MOTO' | 'NONE';

const MOTO_PREFIX = 'รย.12-';

export function vehicleKindOf(body: string | null | undefined): VehicleKind {
  return body?.startsWith(MOTO_PREFIX) ? 'moto' : 'car';
}

export function vehicleScopeFor(roles: UserRole[]): VehicleScope {
  if (roles.includes('ADMIN') || roles.includes('ACCOUNTANT') || roles.includes('DELIVERY')) return 'ALL';
  const car = roles.includes('STAFF_CAR');
  const moto = roles.includes('STAFF_MOTO');
  if (car && moto) return 'ALL';
  if (car) return 'CAR';
  if (moto) return 'MOTO';
  return 'NONE';
}

// ขอบเขตของคำขอปัจจุบัน - นอกคำขอ HTTP (unit test/script) ไม่จำกัด
export function currentVehicleScope(): VehicleScope {
  const user = currentUser();
  return user ? vehicleScopeFor(user.roles) : 'ALL';
}

// เงื่อนไข Prisma สำหรับ where ของตาราง Vehicle - กระจายเข้า where เดิมได้เลย ({ ...where, ...vehicleTypeWhere() })
// ใช้ AND เพื่อไม่ชนกับ OR/NOT ที่ where เดิมอาจมีอยู่แล้ว
export function vehicleTypeWhere(scope: VehicleScope = currentVehicleScope()) {
  if (scope === 'ALL') return {};
  if (scope === 'MOTO') return { AND: [{ body: { startsWith: MOTO_PREFIX } }] };
  if (scope === 'CAR') return { AND: [{ OR: [{ body: null }, { NOT: { body: { startsWith: MOTO_PREFIX } } }] }] };
  return { AND: [{ id: { in: [] as string[] } }] }; // NONE: ไม่เห็นคันไหนเลย
}

export function isVehicleInScope(body: string | null | undefined, scope: VehicleScope = currentVehicleScope()): boolean {
  if (scope === 'ALL') return true;
  if (scope === 'NONE') return false;
  return vehicleKindOf(body) === (scope === 'MOTO' ? 'moto' : 'car');
}

export function scopeErrorMessage(scope: VehicleScope): string {
  if (scope === 'CAR') return 'บัญชีของคุณดูแลเฉพาะรถยนต์ - รถคันนี้เป็นจักรยานยนต์';
  if (scope === 'MOTO') return 'บัญชีของคุณดูแลเฉพาะจักรยานยนต์ - รถคันนี้เป็นรถยนต์';
  return 'บัญชีของคุณไม่มีสิทธิ์ทำงานขั้นยื่นเอกสาร/รับของ';
}

export function assertVehicleInScope(body: string | null | undefined) {
  const scope = currentVehicleScope();
  if (!isVehicleInScope(body, scope)) throw new ForbiddenException({ error: scopeErrorMessage(scope) });
}

// ขั้น 2 แจ้งย้าย/ตัดบัญชี: ADMIN/STAFF_ENTRY ทุกคัน, STAFF_MOTO เฉพาะจักรยานยนต์ (ผู้ใช้ 2026-09-24)
// access-policy.ts กันบทบาทอื่นไว้แล้ว - นอกคำขอ HTTP ไม่จำกัด
export function canEditTransferNotice(roles: UserRole[], body: string | null | undefined): boolean {
  if (roles.includes('ADMIN') || roles.includes('STAFF_ENTRY')) return true;
  return roles.includes('STAFF_MOTO') && vehicleKindOf(body) === 'moto';
}

export function assertTransferNoticeInScope(body: string | null | undefined) {
  const user = currentUser();
  if (user && !canEditTransferNotice(user.roles, body)) {
    throw new ForbiddenException({ error: 'บัญชีของคุณแจ้งย้าย/ตัดบัญชีได้เฉพาะจักรยานยนต์ - รถคันนี้เป็นรถยนต์' });
  }
}

// แท็บรูปป้าย (car | moto) ต้องอยู่ในขอบเขตเดียวกัน
export function assertKindInScope(kind: VehicleKind) {
  const scope = currentVehicleScope();
  if (scope === 'ALL') return;
  if ((scope === 'CAR' && kind === 'car') || (scope === 'MOTO' && kind === 'moto')) return;
  throw new ForbiddenException({ error: scope === 'CAR' ? 'บัญชีของคุณดูแลเฉพาะรถยนต์' : scope === 'MOTO' ? 'บัญชีของคุณดูแลเฉพาะจักรยานยนต์' : scopeErrorMessage(scope) });
}
