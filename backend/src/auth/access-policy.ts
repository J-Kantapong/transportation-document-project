import type { UserRole } from '../generated/prisma/enums.js';

// ตารางสิทธิ์ทั้งระบบอยู่ที่นี่ที่เดียว (frontend/src/lib/auth.ts มีสำเนาฝั่งเมนู/หน้า - แก้ให้ตรงกัน)
// กติกา (ผู้ใช้ 2026-09-22):
// - ADMIN ทำได้ทุกอย่าง
// - STAFF_ENTRY ขั้น 1-3 (เพิ่มข้อมูลรถ/แจ้งย้าย/ตรวจรถ + ข้อมูลอ้างอิง ยี่ห้อ/ไฟแนนซ์/เจ้าของรถ/ยามาฮ่า) ทุกประเภทรถ
// - STAFF_CAR / STAFF_MOTO ขั้น 4-8 (ยื่นเอกสาร/ใบเสร็จ/ป้าย/เล่ม/Delivery) - ประเภทรถกรองเพิ่มใน vehicle-scope.ts
//   และอ่านข้อมูลขั้น 1-3 ได้ (read-only) ยกเว้น STAFF_MOTO บันทึกขั้น 2 แจ้งย้าย/ตัดบัญชีของจักรยานยนต์ได้ (ผู้ใช้ 2026-09-24)
// - ACCOUNTANT วางบิล + อ่านข้อมูลงานทุกขั้นได้ | DELIVERY เฉพาะ /api/delivery | CUSTOMER เฉพาะ /api/portal
// - ฐานข้อมูลลูกค้า: พนักงานทุกกลุ่มอ่านได้ เพิ่มได้เฉพาะ ADMIN
export type Access = 'PUBLIC' | 'ANY_USER' | UserRole[];

const ENTRY: UserRole[] = ['ADMIN', 'STAFF_ENTRY'];
const SUBMIT: UserRole[] = ['ADMIN', 'STAFF_CAR', 'STAFF_MOTO'];
const SUBMIT_READ: UserRole[] = [...SUBMIT, 'ACCOUNTANT'];
const ALL_STAFF_READ: UserRole[] = ['ADMIN', 'STAFF_ENTRY', 'STAFF_CAR', 'STAFF_MOTO', 'ACCOUNTANT'];

interface Rule {
  pattern: RegExp; // ทดสอบกับ path (ไม่มี query string, ตัด / ท้ายแล้ว)
  method?: 'GET' | 'DELETE'; // ไม่ระบุ = ทุก method
  access: Access;
}

// เรียงจากเจาะจงมากไปน้อย - ใช้กฎแรกที่ตรง
const RULES: Rule[] = [
  { pattern: /^\/api\/auth\/(login|register)$/, access: 'PUBLIC' },
  { pattern: /^\/api\/auth(\/|$)/, access: 'ANY_USER' },
  { pattern: /^\/api\/admin(\/|$)/, access: ['ADMIN'] },
  // ภาพรวมผู้บริหาร (ยอดเงินทั้งบริษัท) - ADMIN เท่านั้น บทบาทอื่นจะมีภาพรวมของตัวเองตามมาทีหลัง (ผู้ใช้ 2026-09-24)
  { pattern: /^\/api\/overview(\/|$)/, access: ['ADMIN'] },
  { pattern: /^\/api\/portal(\/|$)/, access: ['CUSTOMER'] },
  { pattern: /^\/api\/billing(\/|$)/, access: ['ADMIN', 'ACCOUNTANT'] },
  // แก้ / ยกเลิกใบส่งงาน (ผู้ใช้ 2026-09-26): ADMIN / STAFF_CAR / STAFF_MOTO เท่านั้น - DELIVERY อ่านใบได้แต่แก้ไม่ได้
  { pattern: /^\/api\/delivery\/slips(\/|$)/, method: 'GET', access: [...SUBMIT, 'DELIVERY'] },
  { pattern: /^\/api\/delivery\/slips(\/|$)/, access: SUBMIT },
  { pattern: /^\/api\/delivery(\/|$)/, access: [...SUBMIT, 'DELIVERY'] },
  // หน้าค้นหารถ + สถานะ (ผู้ใช้ 2026-09-25): พนักงานทุกฝ่าย + บัญชี อ่านอย่างเดียว - ขอบเขตประเภทรถกรองใน service
  { pattern: /^\/api\/vehicle-search(\/|$)/, method: 'GET', access: ALL_STAFF_READ },
  { pattern: /^\/api\/customers$/, method: 'GET', access: ALL_STAFF_READ },
  { pattern: /^\/api\/customers(\/|$)/, access: ['ADMIN'] },
  // ลบ/กู้คืนข้อมูลรถ และรายการรถที่ถูกลบ: ADMIN เท่านั้น (ผู้ใช้ 2026-09-23) - ต้องมาก่อนกฎขั้น 1-3 ด้านล่าง
  { pattern: /^\/api\/vehicles\/deleted$/, access: ['ADMIN'] },
  { pattern: /^\/api\/vehicles\/[^/]+\/restore$/, access: ['ADMIN'] },
  { pattern: /^\/api\/vehicles\/[^/]+$/, method: 'DELETE', access: ['ADMIN'] },
  // ขั้น 4-8: ยื่นเอกสาร / ภาษี / ใบเสร็จ / ป้าย / เล่ม / คิวรับของ + งานสลับเลข (ยื่น/รับเอกสารกลับ - กลุ่มเดียวกัน, รถยนต์ = STAFF_CAR)
  { pattern: /^\/api\/(receipts|plate-photos|book-photos|tax-calculations|plate-swaps|tax-renewals)(\/|$)/, method: 'GET', access: SUBMIT_READ },
  { pattern: /^\/api\/(receipts|plate-photos|book-photos|tax-calculations|plate-swaps|tax-renewals)(\/|$)/, access: SUBMIT },
  { pattern: /^\/api\/vehicles\/(submission-queue|search|document-submission|receiving)(\/|$)/, method: 'GET', access: SUBMIT_READ },
  { pattern: /^\/api\/vehicles\/(submission-queue|search|lookup-by-chassis|document-submission|receiving)(\/|$)/, access: SUBMIT },
  { pattern: /^\/api\/vehicles\/[^/]+\/(document-submission|tax-input|tax-calculations|receiving)(\/|$)/, method: 'GET', access: SUBMIT_READ },
  { pattern: /^\/api\/vehicles\/[^/]+\/(document-submission|tax-input|tax-calculations|receiving)(\/|$)/, access: SUBMIT },
  // ขั้น 2 แจ้งย้าย/ตัดบัญชี: STAFF_MOTO บันทึกได้ด้วย เฉพาะจักรยานยนต์ (ผู้ใช้ 2026-09-24) - service กรองประเภทรถอีกชั้น
  { pattern: /^\/api\/vehicles\/[^/]+\/transfer-notice$/, access: [...ENTRY, 'STAFF_MOTO'] },
  // ขั้น 1-3 + ข้อมูลอ้างอิง: ทุกกลุ่มอ่านได้ เขียนได้เฉพาะ STAFF_ENTRY
  { pattern: /^\/api(\/|$)/, method: 'GET', access: ALL_STAFF_READ },
  { pattern: /^\/api(\/|$)/, access: ENTRY },
];

function matches(rule: Rule, path: string, method: string): boolean {
  if (rule.method && rule.method !== method) return false;
  return rule.pattern.test(path);
}

export function accessFor(path: string, method: string): Access {
  const rule = RULES.find((r) => matches(r, path, method.toUpperCase()));
  return rule?.access ?? 'PUBLIC'; // นอก /api (เช่น health check ที่ "/") เปิดสาธารณะ
}

export function isAllowed(access: Access, roles: UserRole[] | null): boolean {
  if (access === 'PUBLIC') return true;
  if (!roles) return false;
  if (access === 'ANY_USER') return true;
  return roles.some((r) => access.includes(r));
}
