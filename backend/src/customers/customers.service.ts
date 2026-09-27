import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { diffChanges, requireRemark, writeAudit } from '../audit/audit-log.js';
import { round2 } from '../billing/billing-calculator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateCustomerDto } from './dto/create-customer.dto.js';
import type { UpdateCustomerDto } from './dto/update-customer.dto.js';

const CUSTOMER_FIELDS = ['name', 'company', 'branch', 'address', 'taxId', 'phone', 'email'] as const;
type CustomerField = (typeof CUSTOMER_FIELDS)[number];

// ค่าที่ตรวจแล้ว พร้อมเขียนลงตาราง Customer (ช่องที่เว้นว่าง = null ยกเว้นชื่อลูกค้าที่บังคับ)
export type CustomerFields = { name: string } & Record<Exclude<CustomerField, 'name'>, string | null>;

// เงื่อนไขวางบิล (คอลัมน์ billing* ของ Customer)
export interface CustomerTerms {
  billingVat: boolean;
  billingWhtRate: number;
  billingWhtSpecialRate: number | null;
  billingWhtSpecialUntil: Date | null;
}

export const REMARK_MAX_LENGTH = 500;

const bad = (error: string) => new BadRequestException({ error });

// ตรวจ 7 ช่องของลูกค้า - ใช้ทั้งตอนเพิ่มและตอนแก้ (ผู้ใช้ 2026-09-27: แก้ได้ด้วยกติกาเดียวกับตอนเพิ่ม)
export function parseCustomerFields(body: unknown): CustomerFields {
  const raw = body as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== 'object' || !CUSTOMER_FIELDS.every((key) => typeof raw[key] === 'string')) {
    throw bad('กรุณาตรวจสอบข้อมูลลูกค้า');
  }

  const values = Object.fromEntries(CUSTOMER_FIELDS.map((key) => [key, (raw[key] as string).trim()])) as Record<CustomerField, string>;

  if (!values.name || CUSTOMER_FIELDS.some((key) => values[key].length > (key === 'address' ? 2000 : 250))) {
    throw bad('กรุณากรอกชื่อลูกค้าและตรวจสอบความยาวข้อมูล');
  }
  if (values.taxId && !/^\d{13}$/.test(values.taxId)) {
    throw bad('เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก');
  }
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    throw bad('กรุณาตรวจสอบอีเมล');
  }

  return {
    name: values.name,
    company: values.company || null,
    branch: values.branch || null,
    address: values.address || null,
    taxId: values.taxId || null,
    phone: values.phone || null,
    email: values.email || null,
  };
}

function parsePercent(raw: unknown, label: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100) throw bad(`${label}ต้องอยู่ระหว่าง 0 ถึง 100`);
  return round2(raw);
}

// วันที่ ค.ศ. YYYY-MM-DD ที่มีจริง (31/02 ไม่ผ่าน) -> Date เที่ยงคืน UTC แบบเดียวกับคอลัมน์วันที่อื่นของระบบ
function parseIsoDate(raw: unknown, label: string): Date {
  const date = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00.000Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    throw bad(`${label}ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง`);
  }
  return date;
}

// เงื่อนไขวางบิล รูปเดียวกับ PATCH /api/billing/customers/:id/terms { vat, whtRate, whtSpecialRate, whtSpecialUntil }
// กติกาเดียวกับ BillingService.updateTerms: อัตรา 0-100 / อัตราพิเศษต้องมีวันสุดท้ายที่ใช้
export function parseCustomerTerms(raw: unknown): CustomerTerms {
  const dto = raw as { vat?: unknown; whtRate?: unknown; whtSpecialRate?: unknown; whtSpecialUntil?: unknown } | null;
  if (!dto || typeof dto !== 'object') throw bad('กรุณาตรวจสอบเงื่อนไขวางบิล');
  if (typeof dto.vat !== 'boolean') throw bad('ต้องระบุว่ามี VAT หรือไม่');
  const billingWhtRate = parsePercent(dto.whtRate, 'อัตราหัก ณ ที่จ่าย');
  const hasSpecial = dto.whtSpecialRate !== null && dto.whtSpecialRate !== undefined;
  const billingWhtSpecialRate = hasSpecial ? parsePercent(dto.whtSpecialRate, 'อัตราหัก ณ ที่จ่ายพิเศษ') : null;
  if (hasSpecial && !dto.whtSpecialUntil) throw bad('อัตราพิเศษต้องระบุวันสุดท้ายที่ใช้');
  const billingWhtSpecialUntil = hasSpecial ? parseIsoDate(dto.whtSpecialUntil, 'วันสุดท้ายของอัตราพิเศษ') : null;
  return { billingVat: dto.vat, billingWhtRate, billingWhtSpecialRate, billingWhtSpecialUntil };
}

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.customer.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async create(body: CreateCustomerDto): Promise<{ id: string }> {
    const customer = await this.prisma.customer.create({
      data: parseCustomerFields(body),
      select: { id: true },
    });

    return { id: customer.id };
  }

  // แก้ข้อมูลลูกค้า (ผู้ใช้ 2026-09-27): ADMIN เท่านั้น (access-policy.ts) ต้องมีเหตุผล และเก็บค่าก่อน/หลังลง AuditLog
  // แก้ชื่อ/ที่อยู่/เลขภาษีแล้ว บิลที่ออกไปแล้วไม่เปลี่ยน (Invoice.customerSnapshot เก็บค่าตอนออกบิล) - บิลใหม่ใช้ค่าใหม่
  async update(id: string, body: UpdateCustomerDto) {
    const remark = requireRemark(body?.remark, 'กรุณาระบุเหตุผลที่แก้ไขข้อมูลลูกค้า');
    if (remark.length > REMARK_MAX_LENGTH) throw bad(`เหตุผลยาวเกิน ${REMARK_MAX_LENGTH} ตัวอักษร`);
    const fields = parseCustomerFields(body);
    const terms = body.terms === undefined ? null : parseCustomerTerms(body.terms);
    const data = { ...fields, ...(terms ?? {}) };
    // หน้าแก้ส่ง 7 ช่องครบจากข้อมูลตอนเปิด - ต้องรู้ว่าเปิดจากค่าไหน ไม่งั้นค่าเก่าในหน้าจะทับที่คนอื่นเพิ่งแก้ (รีวิว 2026-09-27)
    const expectedUpdatedAt = typeof body.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt.trim() : '';
    if (!expectedUpdatedAt) throw bad('ไม่พบเวลาที่เปิดข้อมูลลูกค้า กรุณาปิดแล้วเปิดใหม่');

    return this.prisma.$transaction(async (tx) => {
      // ล็อกแถวก่อนอ่านค่าเดิม: ADMIN 2 คนแก้พร้อมกัน ประวัติต้องมีค่า "ก่อนแก้" ที่ถูกต้องของแต่ละครั้ง
      await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${id} FOR UPDATE`;
      const current = await tx.customer.findUnique({ where: { id } });
      if (!current) throw new NotFoundException({ error: 'ไม่พบข้อมูลลูกค้า' });
      // มีคนแก้ไปก่อน (หน้านี้ หรือเงื่อนไขวางบิลในหน้าวางบิล) - ไม่บันทึก ให้โหลดค่าล่าสุดแล้วแก้ใหม่
      if (current.updatedAt.toISOString() !== expectedUpdatedAt) {
        throw new ConflictException({ error: 'ข้อมูลลูกค้าถูกแก้ไขไปแล้ว กรุณาปิดแล้วเปิดใหม่' });
      }

      const changes = diffChanges(current, data);
      if (!Object.keys(changes).length) throw bad('ข้อมูลลูกค้าเหมือนเดิม - ไม่มีอะไรต้องแก้');

      const customer = await tx.customer.update({ where: { id }, data });
      await writeAudit(tx, { entity: 'Customer', entityId: id, action: 'update', remark, changes });
      return { customer };
    });
  }

  // ประวัติการแก้ไขข้อมูลลูกค้า ใหม่สุดก่อน (ADMIN เท่านั้น เหมือนการแก้) - รูปเดียวกับประวัติบิล (BillingService.invoiceHistory)
  async history(id: string) {
    const exists = await this.prisma.customer.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException({ error: 'ไม่พบข้อมูลลูกค้า' });
    const rows = await this.prisma.auditLog.findMany({
      where: { entity: 'Customer', entityId: id },
      orderBy: { createdAt: 'desc' },
      include: { editedBy: { select: { name: true, displayName: true } } },
    });
    const entries = rows.map((e) => ({
      id: e.id,
      action: e.action,
      remark: e.remark,
      changes: e.changes,
      editedBy: e.editedBy ? e.editedBy.displayName || e.editedBy.name : null,
      createdAt: e.createdAt.toISOString(),
    }));
    return { entries };
  }
}
