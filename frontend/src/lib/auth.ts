// ระบบล็อกอิน (ฝั่งเว็บ): token JWT จาก backend เก็บใน cookie "td_token" ของโดเมนเว็บเอง (ตั้งด้วย JS) เพราะ
// frontend (Vercel) กับ backend (Render) อยู่คนละโดเมน cookie httpOnly จาก backend จะไม่ถึง proxy.ts ของ Next
// - ทุก API call แนบ "Authorization: Bearer" (ดู api.ts request) - proxy.ts อ่าน cookie เพื่อกันเข้าหน้าโดยไม่ล็อกอิน
// ตารางสิทธิ์ของหน้าอยู่ล่างสุด - ต้องตรงกับ backend/src/auth/access-policy.ts

// STAFF_ENTRY = ขั้น 1-3 ทุกประเภทรถ | STAFF_CAR / STAFF_MOTO = ขั้น 4-8 เฉพาะรถยนต์ / จักรยานยนต์ (ผู้ใช้ 2026-09-22)
// + STAFF_MOTO บันทึกขั้น 2 แจ้งย้าย/ตัดบัญชีของจักรยานยนต์ได้ด้วย (ผู้ใช้ 2026-09-24)
export type UserRole = 'ADMIN' | 'STAFF_ENTRY' | 'STAFF_CAR' | 'STAFF_MOTO' | 'ACCOUNTANT' | 'DELIVERY' | 'CUSTOMER';
export type UserStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'DISABLED';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  displayName: string | null;
  phone: string | null;
  roles: UserRole[];
  status: UserStatus;
  requestedRole: UserRole | null;
  requestedCompany: string | null;
  customerId: string | null;
  customerName: string | null;
  createdAt: string;
  approvedAt: string | null;
}

export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'ผู้ดูแลระบบ',
  STAFF_ENTRY: 'พนักงานรับข้อมูลรถ',
  STAFF_CAR: 'พนักงานยื่นรถยนต์',
  STAFF_MOTO: 'พนักงานยื่นจักรยานยนต์',
  ACCOUNTANT: 'บัญชี',
  DELIVERY: 'ส่งของ',
  CUSTOMER: 'ลูกค้า',
};

// ขอบเขตประเภทรถของขั้น 4-8 (สำเนาของ backend/src/auth/vehicle-scope.ts) - ใช้ซ่อนแท็บ/ข้อมูลที่ backend จะกรองอยู่แล้ว
export type VehicleScope = 'ALL' | 'CAR' | 'MOTO' | 'NONE';
export function vehicleScopeFor(roles: UserRole[]): VehicleScope {
  if (roles.includes('ADMIN') || roles.includes('ACCOUNTANT') || roles.includes('DELIVERY')) return 'ALL';
  const car = roles.includes('STAFF_CAR');
  const moto = roles.includes('STAFF_MOTO');
  if (car && moto) return 'ALL';
  if (car) return 'CAR';
  if (moto) return 'MOTO';
  return 'NONE';
}

export const STATUS_LABELS: Record<UserStatus, string> = {
  PENDING: 'รออนุมัติ',
  APPROVED: 'ใช้งานได้',
  REJECTED: 'ไม่อนุมัติ',
  DISABLED: 'ระงับ',
};

// ตำแหน่งที่พนักงานเลือกได้ตอนสมัคร (Admin เปลี่ยนได้ตอนอนุมัติ) - ไม่มี ADMIN
export const STAFF_REQUESTABLE_ROLES: UserRole[] = ['STAFF_ENTRY', 'STAFF_CAR', 'STAFF_MOTO', 'ACCOUNTANT', 'DELIVERY'];

export const TOKEN_COOKIE = 'td_token';
const USER_KEY = 'td_user';

export function getToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${TOKEN_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(TOKEN_COOKIE.length + 1)) : null;
}

export function getCachedUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export function saveSession(token: string, user: AuthUser) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  // อายุ cookie = อายุ token (ล็อกอิน = 12 ชม.; token ที่ /api/auth/me ออกใหม่ = เวลาที่เหลือ) - backend ตรวจวันหมดอายุจริงอีกชั้น
  // คิดจาก exp - iat ที่ backend ใส่มา ไม่ใช้นาฬิกาเครื่องผู้ใช้ (เครื่องที่ตั้งเวลาผิดจะได้ไม่ถูกลบ cookie ทันที)
  const payload = tokenPayload(token);
  const lifetime = typeof payload?.exp === 'number' && typeof payload.iat === 'number' ? payload.exp - payload.iat : 12 * 60 * 60;
  const maxAge = Math.max(0, Math.min(lifetime, 12 * 60 * 60));
  document.cookie = `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {}
}

export function cacheUser(user: AuthUser) {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {}
}

export function clearSession() {
  document.cookie = `${TOKEN_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  try {
    localStorage.removeItem(USER_KEY);
  } catch {}
}

// เรียกจาก api.ts เมื่อ backend ตอบ 401 (token หมดอายุ/บัญชีถูกระงับ) - ล้าง session แล้วพาไปหน้าล็อกอิน
export function redirectToLogin() {
  if (typeof window === 'undefined') return;
  clearSession();
  const next = window.location.pathname + window.location.search;
  // full reload โดยตั้งใจ ให้ proxy.ts เห็นว่า cookie หายแล้วและล้าง state ทุกหน้า
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.href = `/login${next && next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`;
}

function tokenPayload(token: string): { roles?: unknown; exp?: number; iat?: number } | null {
  try {
    const body = token.split('.')[1];
    return JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as { roles?: unknown; exp?: number; iat?: number };
  } catch {
    return null;
  }
}

// อ่าน roles จาก payload ของ JWT โดยไม่ตรวจลายเซ็น - ใช้แค่เลือกหน้าใน proxy.ts (backend ตรวจสิทธิ์จริง)
export function rolesFromToken(token: string): UserRole[] {
  const payload = tokenPayload(token);
  if (!payload) return [];
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) return [];
  return Array.isArray(payload.roles) ? (payload.roles as UserRole[]) : [];
}

// roles ใน token ตรงกับ roles จริงจาก /api/auth/me ไหม (ไม่สนลำดับ และไม่ดูวันหมดอายุ - นั่นเป็นหน้าที่ของ backend)
// AppShell ใช้ดูว่าต้องเก็บ token ใหม่หลัง Admin เปลี่ยนบทบาทหรือเปล่า
export function tokenHasRoles(token: string | null, roles: UserRole[]): boolean {
  const raw = token ? tokenPayload(token)?.roles : undefined;
  const inToken = Array.isArray(raw) ? (raw as UserRole[]) : [];
  return inToken.length === roles.length && roles.every((role) => inToken.includes(role));
}

export const PUBLIC_PATHS = ['/login', '/register'];

const ENTRY_STAFF: UserRole[] = ['ADMIN', 'STAFF_ENTRY'];
const SUBMIT_STAFF: UserRole[] = ['ADMIN', 'STAFF_CAR', 'STAFF_MOTO'];
// ทุกกลุ่มที่ทำงานหลังบ้าน (อ่านหน้าขั้น 1-3 และรายชื่อลูกค้าได้)
const ALL_STAFF: UserRole[] = ['ADMIN', 'STAFF_ENTRY', 'STAFF_CAR', 'STAFF_MOTO', 'ACCOUNTANT'];

// หน้าแรกของแต่ละบทบาทหลังล็อกอิน (พนักงานไม่เห็นภาพรวม - ผู้ใช้ 2026-09-22)
export function homeFor(roles: UserRole[]): string {
  if (roles.includes('CUSTOMER')) return '/portal';
  if (roles.includes('ADMIN')) return '/';
  const entry = roles.includes('STAFF_ENTRY');
  const submit = roles.includes('STAFF_CAR') || roles.includes('STAFF_MOTO');
  if (entry && submit) return '/registration/new-vehicle';
  if (entry) return '/registration/new-vehicle/entry';
  if (submit) return '/registration/new-vehicle/submit-documents';
  if (roles.includes('ACCOUNTANT')) return '/accounting/billing';
  if (roles.includes('DELIVERY')) return '/registration/new-vehicle/delivery';
  return '/';
}

interface PageRule {
  prefix: string;
  roles: UserRole[];
  exact?: boolean; // ตรงกับ path นี้เท่านั้น ไม่รวมหน้าย่อย
}

// เรียงจากเจาะจงมากไปน้อย - ใช้กฎแรกที่ตรง (สำเนาของ backend access-policy.ts ฝั่งหน้าเว็บ)
// หน้าภาพรวม "/" เฉพาะ ADMIN + ACCOUNTANT / ฐานข้อมูลลูกค้า: พนักงานดูได้แต่เพิ่มไม่ได้ (ปุ่มเพิ่มซ่อนในหน้า, backend กัน POST)
// ขั้น 1-3 ทุกกลุ่มเปิดดูได้ (STAFF_CAR/MOTO อ่านอย่างเดียว - backend กันการบันทึก) ขั้น 4-8 เฉพาะ STAFF_CAR/MOTO (+ACCOUNTANT อ่าน
// ขั้น 4-7 และรายงานส่งงานของขั้น 8 - ไม่ใช่หน้า Delivery)
const PAGE_RULES: PageRule[] = [
  { prefix: '/admin', roles: ['ADMIN'] },
  { prefix: '/portal', roles: ['CUSTOMER'] },
  { prefix: '/accounting', roles: ['ADMIN', 'ACCOUNTANT'] },
  // รายงานส่งงาน / ใบส่งงาน: ACCOUNTANT อ่านได้ไว้ตรวจก่อนวางบิล แต่หน้า Delivery (คิวบันทึกส่ง) ไม่ได้ (ผู้ใช้ 2026-09-27)
  { prefix: '/registration/new-vehicle/delivery/report', roles: [...SUBMIT_STAFF, 'DELIVERY', 'ACCOUNTANT'] },
  { prefix: '/registration/new-vehicle/delivery', roles: [...SUBMIT_STAFF, 'DELIVERY'] },
  // ขั้นตอนยื่นเอกสาร 4 หน้า (/submit...) เป็นงานบันทึกล้วน - ACCOUNTANT ดูได้แค่รายการที่ยื่นแล้ว (พบ 2026-09-27)
  { prefix: '/registration/new-vehicle/submit-documents/submit', roles: SUBMIT_STAFF },
  { prefix: '/registration/new-vehicle/submit-documents', roles: [...SUBMIT_STAFF, 'ACCOUNTANT'] },
  { prefix: '/registration/new-vehicle/receive-receipt', roles: [...SUBMIT_STAFF, 'ACCOUNTANT'] },
  { prefix: '/registration/new-vehicle/receive-plate', roles: [...SUBMIT_STAFF, 'ACCOUNTANT'] },
  { prefix: '/registration/new-vehicle/receive-book', roles: [...SUBMIT_STAFF, 'ACCOUNTANT'] },
  // งานสลับเลข รถเก่า-รถใหม่ (รถยนต์): ยื่น/รับเอกสารกลับ = กลุ่มยื่นรถยนต์ (+ACCOUNTANT อ่าน) - backend: /api/plate-swaps
  { prefix: '/registration/plate-swap/old-new', roles: ['ADMIN', 'STAFF_CAR', 'ACCOUNTANT'] },
  // ต่อภาษี: กลุ่มยื่นเอกสาร (รถยนต์/จักรยานยนต์ตามขอบเขตของตัวเอง) + ACCOUNTANT อ่าน - backend: /api/tax-renewals
  { prefix: '/registration/tax-renewal', roles: [...SUBMIT_STAFF, 'ACCOUNTANT'] },
  { prefix: '/customers', roles: ALL_STAFF },
  // หน้าค้นหารถ + สถานะ (ผู้ใช้ 2026-09-25) - backend: /api/vehicle-search
  { prefix: '/vehicles', roles: ALL_STAFF },
  { prefix: '/registration', roles: ALL_STAFF },
  { prefix: '/', exact: true, roles: ['ADMIN', 'ACCOUNTANT'] },
];

// หน้าที่ไม่อยู่ในตาราง (เช่น 404) ให้พนักงานทุกกลุ่มเข้าได้
const FALLBACK_ROLES: UserRole[] = ALL_STAFF;

// หน้าขั้น 1-3 บันทึกได้เฉพาะ STAFF_ENTRY (ใช้ซ่อนปุ่ม/แจ้งอ่านอย่างเดียว)
export function canEditEntrySteps(roles: UserRole[]): boolean {
  return roles.some((r) => ENTRY_STAFF.includes(r));
}

// หน้าขั้น 4-8 (ยื่นเอกสาร/ใบเสร็จ/ป้าย/เล่ม/ต่อภาษี) บันทึกได้เฉพาะ ADMIN / STAFF_CAR / STAFF_MOTO - ACCOUNTANT อ่านอย่างเดียว
export function canEditSubmitSteps(roles: UserRole[]): boolean {
  return roles.some((r) => SUBMIT_STAFF.includes(r));
}

// ขอบเขตการ "บันทึก/แก้" (สำเนาของ writeScopeFor ใน backend/src/auth/vehicle-scope.ts): ถือ STAFF_CAR / STAFF_MOTO
// คู่กับ ACCOUNTANT / DELIVERY แล้วแก้ได้เฉพาะประเภทรถของ STAFF_* - ACCOUNTANT / DELIVERY อย่างเดียว = ทุกคัน
export function writeScopeFor(roles: UserRole[]): VehicleScope {
  if (roles.includes('ADMIN')) return 'ALL';
  const car = roles.includes('STAFF_CAR');
  const moto = roles.includes('STAFF_MOTO');
  if (car && moto) return 'ALL';
  if (car) return 'CAR';
  if (moto) return 'MOTO';
  return roles.includes('ACCOUNTANT') || roles.includes('DELIVERY') ? 'ALL' : 'NONE';
}

// ประเภทรถที่หน้าขั้น 4-8 ควรแสดงปุ่มบันทึก/แก้ (ใช้ในหน้าเว็บ): writeScopeFor ให้ ACCOUNTANT / DELIVERY อย่างเดียว = ALL
// เพราะ backend มี access-policy.ts กันอีกชั้น แต่หน้าเว็บต้องถือว่าสองบทบาทนี้ดูอย่างเดียว (พบ 2026-09-27)
export function submitWriteScopeFor(roles: UserRole[]): VehicleScope {
  return canEditSubmitSteps(roles) ? writeScopeFor(roles) : 'NONE';
}

// ขั้น 2 แจ้งย้าย/ตัดบัญชี: STAFF_MOTO บันทึกได้ด้วย เฉพาะจักรยานยนต์ (ผู้ใช้ 2026-09-24)
// สำเนาของ canEditTransferNotice ใน backend/src/auth/vehicle-scope.ts
export function canEditTransferNotice(roles: UserRole[], body: string | null): boolean {
  if (canEditEntrySteps(roles)) return true;
  return roles.includes('STAFF_MOTO') && Boolean(body?.startsWith('รย.12-'));
}

export function canAccessPage(pathname: string, roles: UserRole[]): boolean {
  // "//เว็บอื่น" / "/\เว็บอื่น" ไม่ใช่หน้าในเว็บนี้ - ห้ามหลุดไปใช้ FALLBACK_ROLES (พบ 2026-09-27)
  if (pathname.startsWith('//') || pathname.includes('\\')) return false;
  const rule = PAGE_RULES.find((r) => (r.exact ? pathname === r.prefix : pathname === r.prefix || pathname.startsWith(`${r.prefix}/`)));
  const allowed = rule ? rule.roles : FALLBACK_ROLES;
  return roles.some((role) => allowed.includes(role));
}

// หน้าที่จะพากลับไปหลังล็อกอิน (?next=) - รับเฉพาะหน้าในเว็บนี้ที่บทบาทนี้เปิดได้ ไม่งั้น null
// (พบ 2026-09-27: ?next=//เว็บอื่น พาผู้ใช้ไปหน้าล็อกอินปลอมหลังกรอกรหัสผ่านจริงได้)
export function safeNextPath(next: string | null, roles: UserRole[]): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return null;
  try {
    const url = new URL(next, window.location.origin);
    if (url.origin !== window.location.origin || !canAccessPage(url.pathname, roles)) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

export function canCreateCustomer(roles: UserRole[]): boolean {
  return roles.includes('ADMIN');
}

// ลบ/กู้คืนข้อมูลรถจดใหม่: ADMIN เท่านั้น (ผู้ใช้ 2026-09-23) - backend กันอีกชั้นใน access-policy.ts
export function canDeleteVehicle(roles: UserRole[]): boolean {
  return roles.includes('ADMIN');
}

export function displayName(user: AuthUser | null): string {
  if (!user) return '';
  return user.displayName || user.name;
}

export function initials(user: AuthUser | null): string {
  const name = displayName(user).trim();
  return name ? name.slice(0, 2) : 'ผู้';
}
