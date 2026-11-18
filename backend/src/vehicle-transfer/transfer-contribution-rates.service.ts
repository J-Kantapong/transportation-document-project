// ลงขันงานโอนรายจังหวัด (ผู้ใช้ 2026-11-18) - ตาราง TransferContributionRate ครบ 77 จังหวัด ช่องว่าง = ยังไม่ได้ตั้งอัตรา กรอกทีหลังได้
// 3 ช่องต่อจังหวัด: โอน (มอเตอร์ไซค์) / โอน (รถยนต์) / โอนย้ายเข้า (มอเตอร์ไซค์)
// ใช้เป็นค่าตั้งต้นของช่องลงขันในฟอร์มงานโอน (พนักงานแก้รายงานได้) - แก้ตารางไม่กระทบงานที่ยื่นไปแล้ว (งานเก็บยอด ณ วันที่ยื่นไว้เอง)
// อ่าน = กลุ่มยื่นเอกสาร + บัญชี · เขียน = ADMIN (access-policy.ts) · ตั้งครั้งแรกไม่ต้องมีเหตุผล แก้ค่าที่เคยตั้งแล้วต้องมีเหตุผล เก็บประวัติใน AuditLog
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { diffChanges, requireRemark, writeAudit } from '../audit/audit-log.js';
import { currentUser } from '../auth/request-context.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PROVINCES } from '../vehicles/vehicle-reference-data.js';

const FIELD_LABEL = {
  transferMoto: 'ลงขันโอน (มอเตอร์ไซค์)',
  transferCar: 'ลงขันโอน (รถยนต์)',
  moveInMoto: 'ลงขันโอนย้ายเข้า (มอเตอร์ไซค์)',
} as const;
type RateField = keyof typeof FIELD_LABEL;
const RATE_FIELDS = Object.keys(FIELD_LABEL) as RateField[];

export interface ContributionRateInput {
  province?: unknown;
  transferMoto?: unknown;
  transferCar?: unknown;
  moveInMoto?: unknown;
  note?: unknown;
  remark?: unknown;
  expectedUpdatedAt?: unknown;
}

// ว่าง/null = ยังไม่ตั้งอัตรา · ตัวเลขตั้งแต่ 0 (0 = ไม่เสียลงขัน) ทศนิยมไม่เกิน 2 ตำแหน่ง
function parseMoney(raw: unknown, label: string): number | null {
  if (raw === undefined || raw === null) return null;
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : 'x';
  if (text === '') return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) throw new BadRequestException({ error: `${label}ต้องเป็นจำนวนเงินตั้งแต่ 0 (ทศนิยมไม่เกิน 2 ตำแหน่ง)` });
  return Number(text);
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// อัตราลงขันตั้งต้นของงานโอน 1 งาน - null = จังหวัดนี้ยังไม่ได้ตั้งอัตรา (ผู้เรียกตัดสินใจว่าจะบังคับกรอกหรือใช้ 0)
export async function transferContributionRate(
  db: Pick<Prisma.TransactionClient, 'transferContributionRate'>,
  province: string,
  vehicleClass: 'CAR' | 'MOTO',
  moveIn: boolean,
): Promise<number | null> {
  const row = await db.transferContributionRate.findUnique({ where: { province } });
  if (!row) return null;
  return num(moveIn ? row.moveInMoto : vehicleClass === 'CAR' ? row.transferCar : row.transferMoto);
}

@Injectable()
export class TransferContributionRatesService {
  constructor(private readonly prisma: PrismaService) {}

  // ครบ 77 จังหวัดตามลำดับรายการจังหวัดของระบบ - จังหวัดที่ยังไม่มีแถว = ทุกช่องว่าง
  async findAll() {
    const rows = await this.prisma.transferContributionRate.findMany();
    const editorIds = rows.map((r) => r.updatedById).filter((id): id is string => !!id);
    const users = editorIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: editorIds } }, select: { id: true, name: true, displayName: true } })
      : [];
    const userName = new Map(users.map((u) => [u.id, u.displayName || u.name]));
    const byProvince = new Map(rows.map((r) => [r.province, r]));
    return {
      rates: PROVINCES.map((province) => {
        const r = byProvince.get(province);
        return {
          province,
          transferMoto: num(r?.transferMoto),
          transferCar: num(r?.transferCar),
          moveInMoto: num(r?.moveInMoto),
          note: r?.note ?? null,
          updatedAt: r?.updatedAt.toISOString() ?? null,
          updatedBy: r?.updatedById ? (userName.get(r.updatedById) ?? null) : null,
        };
      }),
    };
  }

  // ตั้ง/แก้อัตราของจังหวัดเดียว (ADMIN) - expectedUpdatedAt = ค่าที่หน้าจอโหลดมา (null = ยังไม่มีแถว) ไม่ตรง = 409
  async save(body: ContributionRateInput) {
    const input = body ?? {};
    const province = typeof input.province === 'string' ? input.province.trim() : '';
    if (!(PROVINCES as readonly string[]).includes(province)) throw new BadRequestException({ error: 'จังหวัดไม่ถูกต้อง' });
    const noteRaw = typeof input.note === 'string' ? input.note.trim() : '';
    if (noteRaw.length > 200) throw new BadRequestException({ error: 'หมายเหตุยาวได้ไม่เกิน 200 ตัวอักษร' });
    const data = {
      transferMoto: parseMoney(input.transferMoto, FIELD_LABEL.transferMoto),
      transferCar: parseMoney(input.transferCar, FIELD_LABEL.transferCar),
      moveInMoto: parseMoney(input.moveInMoto, FIELD_LABEL.moveInMoto),
      note: noteRaw || null,
    };
    const expected = input.expectedUpdatedAt === undefined ? undefined : input.expectedUpdatedAt === null ? null : String(input.expectedUpdatedAt);

    return this.prisma.$transaction(async (tx) => {
      const before = await tx.transferContributionRate.findUnique({ where: { province } });
      if (expected !== undefined && (before?.updatedAt.toISOString() ?? null) !== expected) {
        throw new ConflictException({ error: 'อัตราของจังหวัดนี้ถูกแก้ไปแล้ว กรุณาโหลดใหม่' });
      }
      const changes = diffChanges(before ?? {}, data);
      if (Object.keys(changes).length === 0) throw new BadRequestException({ error: 'ไม่มีข้อมูลที่เปลี่ยน' });
      // เติมช่องที่ยังว่างครั้งแรกไม่ต้องมีเหตุผล (ผู้ใช้จะทยอยกรอกทีหลัง) - เปลี่ยน/ลบอัตราที่เคยตั้งแล้วต้องมีเหตุผล
      const overwrites = RATE_FIELDS.some((f) => before?.[f] !== null && before?.[f] !== undefined && num(before[f]) !== data[f]);
      const typedRemark = typeof input.remark === 'string' ? input.remark.trim() : '';
      const remark = overwrites ? requireRemark(input.remark, 'กรุณาระบุเหตุผลที่แก้อัตราลงขัน') : typedRemark || 'ตั้งอัตราลงขันครั้งแรก';
      const updatedById = currentUser()?.id ?? null;
      const saved = before
        ? await tx.transferContributionRate.update({ where: { province }, data: { ...data, updatedById } })
        : await tx.transferContributionRate.create({ data: { province, ...data, updatedById } });
      await writeAudit(tx, {
        entity: 'TransferContributionRate',
        entityId: saved.id,
        action: before ? 'update' : 'create',
        remark,
        changes: { province, ...changes },
      });
      return { province, updatedAt: saved.updatedAt.toISOString() };
    });
  }
}
