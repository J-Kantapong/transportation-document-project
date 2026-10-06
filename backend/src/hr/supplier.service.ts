import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { diffChanges, requireRemark, writeAudit } from '../audit/audit-log.js';
import { round2 } from '../billing/billing-calculator.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { INCOME_TYPES, isValidThaiId, type IncomeType } from './wht-issue-calc.js';

// ทะเบียนผู้รับเงินที่ไม่ใช่พนักงาน (ซับ/ผู้รับจ้างบุคคลธรรมดา) ไว้ออก 50 ทวิ (ผู้ใช้ 2026-10-06) - ADMIN เท่านั้น (อยู่ใต้ /api/hr)
// แยกจาก Employee; ไม่ลบแถว (เลิกใช้ = INACTIVE); แก้ไข/เลิกใช้/ใช้ต่อ ต้องมีเหตุผลและเขียน AuditLog entity 'Supplier'
// ใบ 50 ทวิ ที่ออกไปแล้วเก็บ snapshot ของผู้รับเอง - แก้ทะเบียนทีหลังไม่ทำให้ใบเก่าเปลี่ยน

const bad = (error: string) => new BadRequestException({ error });

// ประเภทเงินได้ที่ตั้งเป็นค่าเริ่มต้นได้ (เงินเดือน 40(1) ใช้กับพนักงานเท่านั้น)
const DEFAULT_TYPES: readonly IncomeType[] = INCOME_TYPES.filter((t) => t !== 'SALARY');

type SupplierRow = Prisma.SupplierGetPayload<{ include: { _count: { select: { whtCertificates: true } } } }>;

const INCLUDE = { _count: { select: { whtCertificates: true } } } as const;

export function mapSupplier(s: SupplierRow) {
  return {
    id: s.id,
    name: s.name,
    taxId: s.taxId,
    address: s.address,
    defaultIncomeType: s.defaultIncomeType as IncomeType,
    defaultDescription: s.defaultDescription,
    defaultRate: Number(s.defaultRate),
    status: s.status as 'ACTIVE' | 'INACTIVE',
    note: s.note,
    certificateCount: s._count.whtCertificates,
    updatedAt: s.updatedAt.toISOString(),
  };
}

export interface SupplierInput {
  name?: unknown;
  taxId?: unknown;
  address?: unknown;
  defaultIncomeType?: unknown;
  defaultDescription?: unknown;
  defaultRate?: unknown;
  note?: unknown;
}

function optionalText(raw: unknown, max: number, label: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw bad(`${label}ต้องเป็นข้อความ`);
  const t = raw.trim();
  if (t.length > max) throw bad(`${label}ยาวเกิน ${max} ตัวอักษร`);
  return t || null;
}

// ตรวจข้อมูลผู้รับเงิน (ใช้ทั้งเพิ่มและแก้ - ฟอร์มส่งครบทุกช่อง)
export function parseSupplier(dto: SupplierInput) {
  const name = typeof dto?.name === 'string' ? dto.name.replace(/\s+/g, ' ').trim() : '';
  if (!name || name.length > 150) throw bad('กรุณาระบุชื่อ-สกุลผู้รับเงิน (ไม่เกิน 150 ตัวอักษร)');
  const taxId = typeof dto.taxId === 'string' ? dto.taxId.replace(/[\s-]/g, '') : '';
  if (!isValidThaiId(taxId)) throw bad('เลขประจำตัวผู้เสียภาษี/บัตรประชาชนต้องเป็นเลข 13 หลักที่ถูกต้อง');
  const defaultIncomeType = (dto.defaultIncomeType ?? 'SERVICE') as IncomeType;
  if (!DEFAULT_TYPES.includes(defaultIncomeType)) throw bad('ประเภทเงินได้เริ่มต้นไม่ถูกต้อง');
  const rate = dto.defaultRate ?? 3;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 100) throw bad('อัตราภาษีต้องอยู่ระหว่าง 0 ถึง 100');
  return {
    name,
    taxId,
    address: optionalText(dto.address, 300, 'ที่อยู่'),
    defaultIncomeType,
    defaultDescription: optionalText(dto.defaultDescription, 120, 'รายละเอียดเริ่มต้น'),
    defaultRate: round2(rate),
    note: optionalText(dto.note, 200, 'หมายเหตุ'),
  };
}

@Injectable()
export class SupplierService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: { status?: string; q?: string }) {
    const where: Prisma.SupplierWhereInput = {};
    if (query.status === 'ACTIVE' || query.status === 'INACTIVE') where.status = query.status;
    const q = query.q?.trim();
    if (q) where.OR = [{ name: { contains: q, mode: 'insensitive' } }, { taxId: { contains: q.replace(/[\s-]/g, '') } }];
    const rows = await this.prisma.supplier.findMany({ where, orderBy: [{ status: 'asc' }, { name: 'asc' }], take: 500, include: INCLUDE });
    return { suppliers: rows.map(mapSupplier) };
  }

  async create(dto: SupplierInput) {
    const data = parseSupplier(dto);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.supplier.create({ data, include: INCLUDE });
        await writeAudit(tx, { entity: 'Supplier', entityId: row.id, action: 'add', remark: `เพิ่ม Supplier ${data.name}`, changes: { ...data } });
        return mapSupplier(row);
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new ConflictException({ error: 'มี Supplier ที่ใช้เลขประจำตัวนี้อยู่แล้ว' });
      throw err;
    }
  }

  async update(id: string, dto: SupplierInput & { remark?: unknown; expectedUpdatedAt?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่แก้ไข');
    if (remark.length > 500) throw bad('เหตุผลยาวเกิน 500 ตัวอักษร');
    const data = parseSupplier(dto);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = await tx.supplier.findUnique({ where: { id }, include: INCLUDE });
        if (!before) throw new NotFoundException({ error: 'ไม่พบ Supplier' });
        if (typeof dto.expectedUpdatedAt === 'string' && dto.expectedUpdatedAt !== before.updatedAt.toISOString()) {
          throw new ConflictException({ error: 'ข้อมูลนี้ถูกแก้ไปแล้ว กรุณาโหลดใหม่' });
        }
        const changes = diffChanges(before, data);
        if (Object.keys(changes).length === 0) throw bad('ไม่มีข้อมูลที่เปลี่ยน');
        const row = await tx.supplier.update({ where: { id }, data, include: INCLUDE });
        await writeAudit(tx, { entity: 'Supplier', entityId: id, action: 'update', remark, changes });
        return mapSupplier(row);
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new ConflictException({ error: 'มี Supplier ที่ใช้เลขประจำตัวนี้อยู่แล้ว' });
      throw err;
    }
  }

  // เลิกใช้ / ใช้ต่อ (ไม่ลบ) - เลิกใช้แล้วไม่ขึ้นในตัวเลือกตอนออกใบ แต่ใบเก่ายังอ้างถึงได้
  async setStatus(id: string, status: 'ACTIVE' | 'INACTIVE', dto: { remark?: unknown }) {
    const remark = requireRemark(dto?.remark, status === 'INACTIVE' ? 'กรุณาระบุเหตุผลที่เลิกใช้' : 'กรุณาระบุเหตุผลที่ใช้ต่อ');
    if (remark.length > 500) throw bad('เหตุผลยาวเกิน 500 ตัวอักษร');
    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.supplier.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException({ error: 'ไม่พบ Supplier' });
      const other = status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
      const { count } = await tx.supplier.updateMany({ where: { id, status: other }, data: { status } });
      if (count === 0) throw new ConflictException({ error: status === 'INACTIVE' ? 'เลิกใช้ไปแล้ว กรุณาโหลดใหม่' : 'ใช้งานอยู่แล้ว กรุณาโหลดใหม่' });
      await writeAudit(tx, { entity: 'Supplier', entityId: id, action: status === 'INACTIVE' ? 'deactivate' : 'reactivate', remark, changes: { status: { from: other, to: status } } });
      return mapSupplier(await tx.supplier.findUniqueOrThrow({ where: { id }, include: INCLUDE }));
    });
  }

  async history(id: string) {
    const logs = await this.prisma.auditLog.findMany({
      where: { entity: 'Supplier', entityId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { editedBy: { select: { name: true, displayName: true } } },
    });
    return { history: logs.map((l) => ({ id: l.id, action: l.action, remark: l.remark, changes: l.changes, by: l.editedBy ? l.editedBy.displayName || l.editedBy.name : null, at: l.createdAt.toISOString() })) };
  }
}
