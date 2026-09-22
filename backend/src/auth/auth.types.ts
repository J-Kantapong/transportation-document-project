import type { UserRole, UserStatus } from '../generated/prisma/enums.js';

// ข้อมูลผู้ใช้ที่ส่งให้หน้าเว็บ (ไม่มี passwordHash) - frontend/src/lib/auth.ts มี interface เดียวกัน
export interface PublicUser {
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

export const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  displayName: true,
  phone: true,
  roles: true,
  status: true,
  requestedRole: true,
  requestedCompany: true,
  customerId: true,
  createdAt: true,
  approvedAt: true,
  customer: { select: { name: true, company: true } },
} as const;

interface UserRow {
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
  createdAt: Date;
  approvedAt: Date | null;
  customer: { name: string; company: string | null } | null;
}

export function customerLabel(customer: { name: string; company: string | null } | null): string | null {
  if (!customer) return null;
  return customer.company && customer.company !== customer.name ? `${customer.name} (${customer.company})` : customer.name;
}

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    displayName: u.displayName,
    phone: u.phone,
    roles: u.roles,
    status: u.status,
    requestedRole: u.requestedRole,
    requestedCompany: u.requestedCompany,
    customerId: u.customerId,
    customerName: customerLabel(u.customer),
    createdAt: u.createdAt.toISOString(),
    approvedAt: u.approvedAt?.toISOString() ?? null,
  };
}

// req.user ที่ AuthGuard แนบให้ทุกคำขอที่ผ่านการยืนยันตัวตน
export interface RequestUser {
  id: string;
  roles: UserRole[];
  customerId: string | null;
  name: string;
}
