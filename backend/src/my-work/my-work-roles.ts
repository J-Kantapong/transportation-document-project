// งานของฉัน (ผู้ใช้ 2026-10-13 "ภาพรวมให้พนักงานแต่ละ Role ในการจัดการเอกสารที่ติดขัด"): ฟังก์ชันล้วน ไม่แตะฐานข้อมูล
// - บทบาทไหนรับผิดชอบขั้นไหน (ตรงกับที่ access-policy.ts ให้บันทึกได้) และเห็นรถประเภทไหน
// - ลิงก์ "ไปจัดการ" ของแต่ละรายการ สร้างที่ฝั่งนี้ให้เสร็จ (สำเนา workPageFor ของ frontend/src/lib/vehicle-focus.ts
//   บวกกรณีบัญชีที่บันทึกส่งงานได้จากหน้าวางบิลเท่านั้น) หน้าเว็บจึงใช้ href ตรงๆ
// ภาพรวมผู้บริหาร (overview.service.ts) ใช้กติกา "รออะไร" ชุดเดียวกัน (overview-process.ts) ตัวเลขจึงตรงกัน

import type { UserRole } from '../generated/prisma/enums.js';
import type { VehicleKind } from '../auth/vehicle-scope.js';
import { STAGES, type Flag, type StageKey } from '../overview/overview-process.js';

const ALL_STAGES = Object.keys(STAGES) as StageKey[];
const ENTRY_STAGES: StageKey[] = ['transfer', 'inspectSend', 'inspectResult'];
// ขั้น 4-8 ของรถจดใหม่ + งานอื่นทุกประเภท (สลับเลข ต่อภาษี โอน ยกเลิกการใช้ ย้ายออก คัดป้าย) + ส่งงานลูกค้า
const SUBMIT_STAGES: StageKey[] = [
  'submit',
  'receipt',
  'plate',
  'book',
  'delivery',
  'plateDelivery',
  'plateSwap',
  'taxRenewal',
  'useCancel',
  'moveOut',
  'plateCopy',
  'plateCopyPlate',
  'transferInspectSend',
  'transferInspectResult',
  'transferJob',
  'jobDelivery',
];
const DELIVERY_STAGES: StageKey[] = ['delivery', 'plateDelivery', 'jobDelivery'];

// ขั้นที่แต่ละบทบาท "ทำได้" - ไม่ใช่ขั้นที่อ่านได้ (บัญชีอ่านได้ทุกขั้น แต่ต้องรับผิดชอบเฉพาะวางบิล + ส่งงานที่ค้าง)
// STAFF_MOTO ทำขั้น 2 แจ้งย้ายของจักรยานยนต์ได้ด้วย (ผู้ใช้ 2026-09-24) - ประเภทรถกรองด้วย KIND_OF_ROLE
const ROLE_STAGES: Record<UserRole, StageKey[]> = {
  ADMIN: ALL_STAGES,
  STAFF_ENTRY: ENTRY_STAGES,
  STAFF_CAR: SUBMIT_STAGES,
  STAFF_MOTO: ['transfer', ...SUBMIT_STAGES],
  ACCOUNTANT: ['billing', ...DELIVERY_STAGES],
  DELIVERY: DELIVERY_STAGES,
  CUSTOMER: [],
};

// ประเภทรถของบทบาท - null = ทุกประเภท
const KIND_OF_ROLE: Record<UserRole, VehicleKind | null> = {
  ADMIN: null,
  STAFF_ENTRY: null,
  STAFF_CAR: 'car',
  STAFF_MOTO: 'moto',
  ACCOUNTANT: null,
  DELIVERY: null,
  CUSTOMER: null,
};

export function stagesFor(roles: UserRole[]): StageKey[] {
  const keys = new Set<StageKey>();
  for (const role of roles) for (const stage of ROLE_STAGES[role] ?? []) keys.add(stage);
  return ALL_STAGES.filter((k) => keys.has(k)); // คงลำดับขั้นตอน
}

// รายการนี้อยู่ในความรับผิดชอบของผู้ใช้ไหม: มีบทบาทใดบทบาทหนึ่งที่ทำขั้นนี้ได้ และดูแลรถประเภทนี้
// (STAFF_ENTRY + STAFF_CAR = ขั้น 1-3 ทุกคัน แต่ขั้น 4-8 เฉพาะรถยนต์) · kind null = ไม่รู้ประเภท (ใบส่งงานที่ไม่มีรถ) ให้ทุกคนที่ทำขั้นนั้นเห็น
export function isMine(roles: UserRole[], stage: StageKey, kind: VehicleKind | null): boolean {
  return roles.some((role) => ROLE_STAGES[role]?.includes(stage) && (kind === null || KIND_OF_ROLE[role] === null || KIND_OF_ROLE[role] === kind));
}

// ประเภทรถที่ผู้ใช้เห็นในขั้นนี้ (ใช้กรองคิวค้างรายขั้น) - null = ไม่เห็นขั้นนี้เลย
export function kindsFor(roles: UserRole[], stage: StageKey): VehicleKind[] | null {
  const kinds = (['car', 'moto'] as VehicleKind[]).filter((kind) => isMine(roles, stage, kind));
  return kinds.length ? kinds : null;
}

// ตัวช่วยตรวจ ("ตรวจก่อนผิด") แต่ละเรื่องเป็นของบทบาทไหน
export type CheckOwner = 'entry' | 'submit' | 'delivery' | 'accounting';
const CHECK_OWNERS: Record<UserRole, CheckOwner[]> = {
  ADMIN: ['entry', 'submit', 'delivery', 'accounting'],
  STAFF_ENTRY: ['entry'],
  STAFF_CAR: ['submit', 'delivery'],
  STAFF_MOTO: ['submit', 'delivery'],
  ACCOUNTANT: ['accounting', 'delivery'],
  DELIVERY: ['delivery'],
  CUSTOMER: [],
};

export function hasCheckOwner(roles: UserRole[], owner: CheckOwner): boolean {
  return roles.some((role) => CHECK_OWNERS[role]?.includes(owner));
}

// --- ลิงก์ไปจัดการ ------------------------------------------------------------------------

export const PLATE_SWAP_RETURN_PAGE = '/registration/plate-swap/car/old-new/receive-receipt';
// หน้าที่มีรายการรถจริงของแต่ละขั้น (ไม่ใช่หน้าเมนู) - สำเนา STAGE_PAGES ใน frontend/src/lib/vehicle-focus.ts
const STAGE_PAGES: Partial<Record<StageKey, string>> = {
  plateSwap: PLATE_SWAP_RETURN_PAGE,
  transfer: '/registration/new-vehicle/transfer-notice',
  inspectSend: '/registration/new-vehicle/inspection',
  inspectResult: '/registration/new-vehicle/inspection/result',
  submit: '/registration/new-vehicle/submit-documents/submit',
  receipt: '/registration/new-vehicle/receive-receipt',
  plate: '/registration/new-vehicle/receive-plate',
  book: '/registration/new-vehicle/receive-book',
  delivery: '/delivery',
  plateDelivery: '/delivery',
  billing: '/accounting/billing',
};
const KIND_PAGES: StageKey[] = ['receipt', 'plate', 'book'];

export function focusUrl(page: string, value: string, extra: Record<string, string> = {}): string {
  return `${page}?${new URLSearchParams({ ...extra, focus: value }).toString()}`;
}

// บัญชีที่ไม่ได้ถือบทบาทส่งงาน เปิดหน้า Delivery ไม่ได้ (ผู้ใช้ 2026-09-27) แต่บันทึกส่งงานได้จากแผงในหน้าวางบิล (ผู้ใช้ 2026-10-08)
export function canOpenDeliveryPage(roles: UserRole[]): boolean {
  return roles.some((r) => r === 'ADMIN' || r === 'STAFF_CAR' || r === 'STAFF_MOTO' || r === 'DELIVERY');
}

export interface LinkSubject {
  source: 'vehicle' | 'plateSwap' | 'taxRenewal' | 'otherJob';
  stage: StageKey;
  kind: VehicleKind;
  chassis: string;
  flags: Flag[];
  href: string; // หน้าของขั้น (STAGES[stage].href) หรือหน้าของงานนั้นที่ backend ใส่มา
}

export function workHrefFor(item: LinkSubject, roles: UserRole[]): string {
  const deliveryPage = canOpenDeliveryPage(roles) ? '/delivery' : '/accounting/billing';
  if (item.stage === 'jobDelivery') return focusUrl(deliveryPage, item.chassis);
  if (item.stage === 'delivery' || item.stage === 'plateDelivery') return focusUrl(deliveryPage, item.chassis);
  // ต่อภาษีและงานอื่นๆ: หน้าของงานนั้นจาก backend (รับใบเสร็จ / รับป้าย / ส่งตรวจ) - หน้าเหล่านั้นไม่ได้เลื่อนไปที่แถวทุกหน้า
  if (item.source !== 'vehicle' && item.source !== 'plateSwap') return item.href;
  // รอเอกสารสลับเลข: คิวยื่นเอกสารซ่อนรถคันนี้ไว้ งานที่ต้องทำคือรับเอกสารสลับเลขกลับ
  if (item.stage === 'submit' && item.flags.includes('PLATE_SWAP_PENDING')) return focusUrl(PLATE_SWAP_RETURN_PAGE, item.chassis);
  const base = STAGE_PAGES[item.stage] ?? item.href;
  return focusUrl(KIND_PAGES.includes(item.stage) ? `${base}/${item.kind}` : base, item.chassis);
}

// วันที่ (ค.ศ. YYYY-MM-DD) ตามเวลาไทยของเวลาที่บันทึก - ใช้เทียบ "วันที่ที่ลงไว้" กับ "วันที่กดบันทึกจริง"
export function bangkokDateOf(at: Date): string {
  return new Date(at.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
