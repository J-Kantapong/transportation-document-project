import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { currentUser } from '../auth/request-context.js';

// ประวัติการแก้ไข/ยกเลิกของข้อมูลที่ไม่ใช่รถจดใหม่ (ผู้ใช้ 2026-09-27: ทุกการแก้/ยกเลิกต้องมีเหตุผลและประวัติ)
// ลูกค้า ใบวางบิล ต่อภาษี แจ้งย้ายยามาฮ่า สลับเลข ผู้ใช้ -> ตาราง AuditLog / รถจดใหม่ยังใช้ VehicleEditLog เหมือนเดิม
// เรียก writeAudit() ใน transaction เดียวกับการแก้ ถ้าการแก้ล้มประวัติก็ไม่ถูกเขียน
// ผู้ทำอ่านจาก request context (currentUser) เหมือน VehicleEditLog.editedById - นอกคำขอ HTTP (script, test) เป็น null

export type AuditEntity =
  | 'Customer'
  | 'Invoice'
  | 'TaxRenewal'
  | 'YamahaRelocation'
  | 'PlateSwap'
  | 'VehicleUseCancellation'
  | 'VehicleTransfer'
  | 'PlateCopy'
  | 'User'
  | 'CustomerPayment'
  | 'TaxInvoiceSeries'
  | 'TaxInvoice'
  | 'WhtCertificate'
  | 'Quotation'
  | 'Employee'
  | 'PayrollRun'
  | 'PayslipSignature';

export interface AuditEntry {
  entity: AuditEntity;
  entityId: string;
  // คำกริยาสั้นภาษาอังกฤษ เช่น 'update' | 'cancel' | 'unpay' | 'set-password' | 'undo-return'
  // (ปิดงาน/เปิดงานรถ - วางบิลนอกระบบ เป็นการแก้รถ -> VehicleEditLog ไม่ใช่ AuditLog)
  action: string;
  remark: string;
  // { field: { from, to } } (ใช้ diffChanges) หรือ snapshot ก่อนยกเลิก - ใส่ Date/Decimal ได้เลย writeAudit แปลงเป็นข้อความให้
  changes: Record<string, unknown>;
}

export type AuditChanges = Record<string, { from: unknown; to: unknown }>;

// ห้ามเก็บรหัสผ่านลงประวัติ - คีย์ที่มีคำว่า password (รวม passwordHash) ถูกแทนค่าเสมอ แม้ผู้เรียกลืมตัดออก
const HIDDEN = '[ซ่อน]';
const SECRET_KEY = /password/i;

// Prisma.Decimal (decimal.js) - ตรวจแบบ duck typing ไม่ต้อง import ตัว client
const isDecimalLike = (v: object): boolean =>
  typeof (v as { toFixed?: unknown }).toFixed === 'function' && typeof (v as { isFinite?: unknown }).isFinite === 'function';

// แปลงค่าให้เก็บเป็น JSON ได้และอ่านง่าย: Date เที่ยงคืน UTC (ช่องวันที่ของระบบ) -> 'YYYY-MM-DD', Date อื่น -> ISO,
// Decimal -> ข้อความ, undefined -> ตัดทิ้ง (ใน object) / null
export function toAuditJson(value: unknown, key = ''): unknown {
  if (key && SECRET_KEY.test(key) && value !== undefined && value !== null) return HIDDEN;
  if (value === undefined || value === null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' ? null : value;
  if (isDecimalLike(value)) return (value as { toString(): string }).toString();
  if (Array.isArray(value)) return value.map((v) => toAuditJson(v));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = toAuditJson(v, k); // { password: { from, to } } -> ซ่อนทั้งก้อน
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  // หลัง toAuditJson ค่าที่เหลือเป็น string/number/boolean - Decimal '3' กับตัวเลข 3 จาก form = ค่าเดียวกัน
  return String(a as string | number | boolean) === String(b as string | number | boolean);
}

// เทียบค่าก่อน/หลัง คืนเฉพาะฟิลด์ที่เปลี่ยนจริงในรูป { field: { from, to } } (รูปเดียวกับ VehicleEditLog.changes)
// fields ไม่ระบุ = ทุกคีย์ใน after / ค่า undefined ใน after = ไม่ได้แก้ช่องนั้น (เหมือน Prisma update) จึงข้าม
// before/after รับ object ใดก็ได้ (แถวจาก Prisma, ข้อมูลที่ validate แล้ว) ชนิดค่าไม่ต้องตรงกัน เช่น Decimal กับ number
export function diffChanges<A extends object>(before: object, after: A, fields?: ReadonlyArray<keyof A & string>): AuditChanges {
  const prev = before as Record<string, unknown>;
  const next = after as Record<string, unknown>;
  const changes: AuditChanges = {};
  for (const field of fields ?? Object.keys(next)) {
    if (next[field] === undefined) continue;
    const from = toAuditJson(prev[field], field);
    const to = toAuditJson(next[field], field);
    if (!sameValue(from, to)) changes[field] = { from, to };
  }
  return changes;
}

// เหตุผลบังคับ: ตัดช่องว่างแล้วต้องไม่ว่าง ไม่งั้นตอบ 400 { error } - ใช้ข้อความเฉพาะงานได้ เช่น 'กรุณาระบุเหตุผลที่ยกเลิกงานต่อภาษี'
export function requireRemark(raw: unknown, error = 'กรุณาระบุเหตุผล'): string {
  const remark = typeof raw === 'string' ? raw.trim() : '';
  if (!remark) throw new BadRequestException({ error });
  return remark;
}

// เขียนประวัติ 1 แถว - db = this.prisma หรือ tx ใน $transaction (ควรใช้ tx เพื่อให้แก้กับประวัติสำเร็จ/ล้มพร้อมกัน)
export async function writeAudit(db: Pick<Prisma.TransactionClient, 'auditLog'>, entry: AuditEntry): Promise<{ id: string }> {
  const remark = requireRemark(entry.remark);
  if (!entry.entity || !entry.entityId || !entry.action) throw new Error('writeAudit: entity, entityId and action are required');
  return db.auditLog.create({
    data: {
      entity: entry.entity,
      entityId: entry.entityId,
      action: entry.action,
      remark,
      changes: toAuditJson(entry.changes ?? {}) as Prisma.InputJsonValue,
      editedById: currentUser()?.id ?? null,
    },
    select: { id: true },
  });
}
