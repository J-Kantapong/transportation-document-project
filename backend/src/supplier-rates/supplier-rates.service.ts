// ราคาซับ (Supplier) จดทะเบียนต่างจังหวัด ต่อจังหวัด (ผู้ใช้ 2026-10-08) - ดูกฎเส้นทางใน document-submission/supplier-route.ts
// ซับคิดตามตารางนี้เสมอ แต่ขึ้นราคาได้: ADMIN แก้ได้จากหน้าจอ ต้องมีเหตุผล เก็บประวัติใน AuditLog (entity SupplierProvinceRate)
// แก้ตารางไม่กระทบรถที่ส่งซับไปแล้ว (รายการยื่นเก็บราคา ณ วันที่ส่งไว้เอง)
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { diffChanges, requireRemark, writeAudit } from '../audit/audit-log.js';
import { currentUser } from '../auth/request-context.js';
import { SELF_REGISTER_PROVINCES } from '../document-submission/supplier-route.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PROVINCES } from '../vehicles/vehicle-reference-data.js';

const MONEY_LABEL = {
  serviceFee: 'ค่าดำเนินการ',
  channelFee: 'ค่าช่อง',
  inspectionFee: 'นำรถเข้าตรวจสภาพ',
  plateSwapFee: 'สลับป้าย',
} as const;

export interface SupplierRateInput {
  province?: unknown;
  accepts?: unknown;
  serviceFee?: unknown;
  channelFee?: unknown;
  inspectionFee?: unknown;
  plateSwapFee?: unknown;
  plateSwapNote?: unknown;
  note?: unknown;
  remark?: unknown;
  expectedUpdatedAt?: unknown;
}

// ว่าง/null = ไม่มีราคา · ตัวเลขตั้งแต่ 0 ทศนิยมไม่เกิน 2 ตำแหน่ง
function parseMoney(raw: unknown, label: string): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : 'x';
  if (text === '') return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) {
    throw new BadRequestException({ error: `${label}ต้องเป็นจำนวนเงินตั้งแต่ 0 (ทศนิยมไม่เกิน 2 ตำแหน่ง)` });
  }
  return Number(text);
}

function parseText(raw: unknown, label: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new BadRequestException({ error: `${label}ไม่ถูกต้อง` });
  const text = raw.trim();
  if (text.length > 200) throw new BadRequestException({ error: `${label}ยาวได้ไม่เกิน 200 ตัวอักษร` });
  return text || null;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

@Injectable()
export class SupplierRatesService {
  constructor(private readonly prisma: PrismaService) {}

  // ทุกจังหวัดที่ส่งซับจด (75 จังหวัด - ไม่รวมกรุงเทพฯ/สมุทรปราการที่ออฟฟิศจดเอง) เรียง ก-ฮ - จังหวัดที่ยังไม่มีแถว = ยังไม่ตั้งราคา
  async findAll() {
    const rows = await this.prisma.supplierProvinceRate.findMany();
    const editorIds = rows.map((r) => r.updatedById).filter((id): id is string => !!id);
    const users = editorIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: editorIds } }, select: { id: true, name: true, displayName: true } })
      : [];
    const userName = new Map(users.map((u) => [u.id, u.displayName || u.name]));
    const byProvince = new Map(rows.map((r) => [r.province, r]));
    const provinces = PROVINCES.filter((p) => !SELF_REGISTER_PROVINCES.includes(p)).sort((a, b) => a.localeCompare(b, 'th'));
    return {
      selfRegisterProvinces: SELF_REGISTER_PROVINCES,
      rates: provinces.map((province) => {
        const r = byProvince.get(province);
        const fees = r ? [num(r.serviceFee), num(r.channelFee), num(r.inspectionFee)] : [null, null, null];
        return {
          province,
          configured: !!r,
          accepts: r?.accepts ?? true,
          serviceFee: fees[0],
          channelFee: fees[1],
          inspectionFee: fees[2],
          // ค่าจ้างซับต่อคัน = 3 ช่องรวมกัน (คิดทุกคัน) - null เมื่อราคายังไม่ครบหรือซับไม่รับ
          total: r?.accepts && fees.every((f) => f !== null) ? fees.reduce<number>((sum, f) => sum + (f ?? 0), 0) : null,
          plateSwapFee: r ? num(r.plateSwapFee) : null,
          plateSwapNote: r?.plateSwapNote ?? null,
          note: r?.note ?? null,
          updatedAt: r?.updatedAt.toISOString() ?? null,
          updatedBy: r?.updatedById ? (userName.get(r.updatedById) ?? null) : null,
        };
      }),
    };
  }

  // ตั้ง/แก้ราคาของจังหวัดเดียว (ADMIN) - เหตุผลบังคับ · expectedUpdatedAt = ค่าที่หน้าจอโหลดมา (null = ยังไม่มีแถว) ไม่ตรง = 409
  async save(body: SupplierRateInput) {
    const input = body ?? {};
    const province = typeof input.province === 'string' ? input.province.trim() : '';
    if (!(PROVINCES as readonly string[]).includes(province)) throw new BadRequestException({ error: 'จังหวัดไม่ถูกต้อง' });
    if (SELF_REGISTER_PROVINCES.includes(province)) {
      throw new BadRequestException({ error: `${province}ออฟฟิศจดทะเบียนเอง - ไม่มีราคาซับ` });
    }
    if (typeof input.accepts !== 'boolean') throw new BadRequestException({ error: 'กรุณาระบุว่าซับรับจดจังหวัดนี้หรือไม่' });
    const remark = requireRemark(input.remark, 'กรุณาระบุเหตุผลที่แก้ราคาซับ');
    const data = {
      accepts: input.accepts,
      serviceFee: parseMoney(input.serviceFee, MONEY_LABEL.serviceFee),
      channelFee: parseMoney(input.channelFee, MONEY_LABEL.channelFee),
      inspectionFee: parseMoney(input.inspectionFee, MONEY_LABEL.inspectionFee),
      plateSwapFee: parseMoney(input.plateSwapFee, MONEY_LABEL.plateSwapFee),
      plateSwapNote: parseText(input.plateSwapNote, 'หมายเหตุสลับป้าย'),
      note: parseText(input.note, 'หมายเหตุ'),
    };
    if (data.accepts) {
      for (const field of ['serviceFee', 'channelFee', 'inspectionFee'] as const) {
        if (data[field] === null) throw new BadRequestException({ error: `กรุณากรอก${MONEY_LABEL[field]} (ไม่มีให้ใส่ 0)` });
      }
    }
    const expected =
      input.expectedUpdatedAt === undefined ? undefined : input.expectedUpdatedAt === null ? null : String(input.expectedUpdatedAt);

    return this.prisma.$transaction(async (tx) => {
      const before = await tx.supplierProvinceRate.findUnique({ where: { province } });
      if (expected !== undefined && (before?.updatedAt.toISOString() ?? null) !== expected) {
        throw new ConflictException({ error: 'ราคาของจังหวัดนี้ถูกแก้ไปแล้ว กรุณาโหลดใหม่' });
      }
      const changes = diffChanges(before ?? {}, data);
      if (before && Object.keys(changes).length === 0) throw new BadRequestException({ error: 'ไม่มีข้อมูลที่เปลี่ยน' });
      const updatedById = currentUser()?.id ?? null;
      const saved = before
        ? await tx.supplierProvinceRate.update({ where: { province }, data: { ...data, updatedById } })
        : await tx.supplierProvinceRate.create({ data: { province, ...data, updatedById } });
      await writeAudit(tx, {
        entity: 'SupplierProvinceRate',
        entityId: saved.id,
        action: before ? 'update' : 'create',
        remark,
        changes: { province, ...changes },
      });
      return { province, updatedAt: saved.updatedAt.toISOString() };
    });
  }

  async history(provinceRaw: string) {
    const province = (provinceRaw ?? '').trim();
    const row = await this.prisma.supplierProvinceRate.findUnique({ where: { province }, select: { id: true } });
    if (!row) return { history: [] };
    const logs = await this.prisma.auditLog.findMany({
      where: { entity: 'SupplierProvinceRate', entityId: row.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { editedBy: { select: { name: true, displayName: true } } },
    });
    return {
      history: logs.map((l) => ({
        id: l.id,
        action: l.action,
        remark: l.remark,
        changes: l.changes,
        by: l.editedBy ? l.editedBy.displayName || l.editedBy.name : null,
        at: l.createdAt.toISOString(),
      })),
    };
  }
}
