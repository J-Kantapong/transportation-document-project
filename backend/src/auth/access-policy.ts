import type { UserRole } from '../generated/prisma/enums.js';

// ตารางสิทธิ์ทั้งระบบอยู่ที่นี่ที่เดียว (frontend/src/lib/auth.ts มีสำเนาฝั่งเมนู/หน้า - แก้ให้ตรงกัน)
// กติกา (ผู้ใช้ 2026-09-22):
// - ADMIN ทำได้ทุกอย่าง
// - STAFF_ENTRY ขั้น 1-3 (เพิ่มข้อมูลรถ/แจ้งย้าย/ตรวจรถ + ข้อมูลอ้างอิง ยี่ห้อ/ไฟแนนซ์/เจ้าของรถ/ยามาฮ่า) ทุกประเภทรถ
// - STAFF_CAR / STAFF_MOTO ขั้น 4-8 (ยื่นเอกสาร/ใบเสร็จ/ป้าย/เล่ม/Delivery) - ประเภทรถกรองเพิ่มใน vehicle-scope.ts
//   และอ่านข้อมูลขั้น 1-3 ได้ (read-only) ยกเว้น STAFF_MOTO บันทึกขั้น 2 แจ้งย้าย/ตัดบัญชีของจักรยานยนต์ได้ (ผู้ใช้ 2026-09-24)
// - ACCOUNTANT วางบิล + อ่านข้อมูลงานทุกขั้นได้ (ขั้น 8 อ่านได้เฉพาะรายงานส่งงาน/ใบส่งงาน ไม่ใช่คิว Delivery - ผู้ใช้ 2026-09-27)
// - DELIVERY เฉพาะ /api/delivery | CUSTOMER เฉพาะ /api/portal
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
  // วางบิล: ADMIN + ACCOUNTANT (รวมแก้บิล / ยกเลิกการรับเงิน / ปิดงาน - วางบิลนอกระบบ) แต่เปิดงานที่ปิดไว้กลับ = ADMIN เท่านั้น (ผู้ใช้ 2026-09-27)
  { pattern: /^\/api\/billing\/vehicles\/[^/]+\/reopen$/, access: ['ADMIN'] },
  // ตั้งเลขเริ่มใบกำกับภาษี (= เปิดใช้ใบกำกับในระบบ) ADMIN เท่านั้น (ผู้ใช้ 2026-09-28)
  { pattern: /^\/api\/billing\/tax-invoices\/series\/set$/, access: ['ADMIN'] },
  { pattern: /^\/api\/billing(\/|$)/, access: ['ADMIN', 'ACCOUNTANT'] },
  // บันทึกการจ่ายของลูกค้า + ตารางล้อ (SPI): พนักงานรถยนต์ดูแลงาน SPI อยู่แล้ว (ผู้ใช้ 2026-09-27) - service กรองเฉพาะรถยนต์ให้ STAFF_CAR
  { pattern: /^\/api\/customer-payments(\/|$)/, access: ['ADMIN', 'ACCOUNTANT', 'STAFF_CAR'] },
  // แก้ / ยกเลิกใบส่งงาน (ผู้ใช้ 2026-09-26): ADMIN / STAFF_CAR / STAFF_MOTO เท่านั้น - DELIVERY อ่านใบได้แต่แก้ไม่ได้
  // ACCOUNTANT อ่านรายงานส่งงานได้ (ใบส่งงาน + ป้ายค้างส่ง) ไว้ตรวจก่อนวางบิล แต่ไม่เห็นคิว Delivery และบันทึก/แก้ไม่ได้ (ผู้ใช้ 2026-09-27)
  { pattern: /^\/api\/delivery\/(slips|plate-pending)(\/|$)/, method: 'GET', access: [...SUBMIT, 'DELIVERY', 'ACCOUNTANT'] },
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
  { pattern: /^\/api\/(receipts|plate-photos|book-photos|tax-calculations|plate-swaps|vehicle-use-cancellations|vehicle-transfers|plate-copies|tax-renewals)(\/|$)/, method: 'GET', access: SUBMIT_READ },
  { pattern: /^\/api\/(receipts|plate-photos|book-photos|tax-calculations|plate-swaps|vehicle-use-cancellations|vehicle-transfers|plate-copies|tax-renewals)(\/|$)/, access: SUBMIT },
  { pattern: /^\/api\/vehicles\/(submission-queue|search|document-submission|receiving)(\/|$)/, method: 'GET', access: SUBMIT_READ },
  { pattern: /^\/api\/vehicles\/(submission-queue|search|lookup-by-chassis|document-submission|receiving)(\/|$)/, access: SUBMIT },
  // route ต่อคันของขั้น 4 เหลือแค่ GET :id/tax-calculations (:id/document-submission, :id/tax-input, :id/receiving/:step ถูกถอดแล้ว - พบ 2026-09-27)
  { pattern: /^\/api\/vehicles\/[^/]+\/tax-calculations(\/|$)/, method: 'GET', access: SUBMIT_READ },
  { pattern: /^\/api\/vehicles\/[^/]+\/tax-calculations(\/|$)/, access: SUBMIT },
  // ขั้น 2 แจ้งย้าย/ตัดบัญชี: STAFF_MOTO บันทึกได้ด้วย เฉพาะจักรยานยนต์ (ผู้ใช้ 2026-09-24) - service กรองประเภทรถอีกชั้น
  // /correct = แก้/ยกเลิกสถานะคันที่ดำเนินการแล้ว (ต้องมีเหตุผล - ผู้ใช้ 2026-09-27) สิทธิ์เดียวกัน
  { pattern: /^\/api\/vehicles\/[^/]+\/transfer-notice(\/correct)?$/, access: [...ENTRY, 'STAFF_MOTO'] },
  // ขั้น 1-3 + ข้อมูลอ้างอิง: ทุกกลุ่มอ่านได้ เขียนได้เฉพาะ STAFF_ENTRY
  { pattern: /^\/api(\/|$)/, method: 'GET', access: ALL_STAFF_READ },
  { pattern: /^\/api(\/|$)/, access: ENTRY },
];

function matches(rule: Rule, path: string, method: string): boolean {
  if (rule.method && rule.method !== method) return false;
  return rule.pattern.test(path);
}

// Express จับ route แบบไม่สนตัวพิมพ์ (/API/admin/users ไปถึง controller เดียวกับ /api/admin/users) แต่กฎด้านบนเป็นตัวเล็ก
// จึงต้องทำ path ให้เป็นรูปเดียวกันก่อนเทียบ ไม่งั้นพิมพ์ URL ตัวใหญ่แล้วข้ามการเข้าสู่ระบบ/ตรวจสิทธิ์ได้ (พบ 2026-09-27)
export function normalizePath(raw: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return path.toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
}

export function accessFor(rawPath: string, method: string): Access {
  const path = normalizePath(rawPath);
  if (path === null) return ['ADMIN'];
  const rule = RULES.find((r) => matches(r, path, method.toUpperCase()));
  if (rule) return rule.access;
  // นอก /api มีแค่ health check ที่ "/" ที่เปิดสาธารณะ - path อื่นที่ไม่มีกฎรองรับให้ ADMIN เท่านั้น (ปิดไว้ก่อนเสมอ)
  return path === '/' ? 'PUBLIC' : ['ADMIN'];
}

export function isAllowed(access: Access, roles: UserRole[] | null): boolean {
  if (access === 'PUBLIC') return true;
  if (!roles) return false;
  if (access === 'ANY_USER') return true;
  return roles.some((r) => access.includes(r));
}
