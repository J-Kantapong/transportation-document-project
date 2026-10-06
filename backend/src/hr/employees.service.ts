import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { diffChanges, requireRemark, writeAudit } from '../audit/audit-log.js';
import { round2 } from '../billing/billing-calculator.js';
import type { Prisma } from '../generated/prisma/client.js';
import { bangkokToday } from '../overview/overview-calculator.js';
import { PrismaService } from '../prisma/prisma.service.js';

// ทะเบียนพนักงาน (ผู้ใช้ 2026-10-05) - ADMIN เท่านั้น (access-policy.ts: /api/hr)
// ข้อมูลส่วนบุคคล (เลขบัตร วันเกิด เงินเดือน) ห้ามใส่ seed/ไฟล์ใน repo - นำเข้าผ่านหน้าจอ (วางจาก Excel) เท่านั้น
// พนักงานไม่ถูกลบ: ลาออก = RESIGNED (ประวัติเงินเดือนเดิมยังอยู่) / แก้ข้อมูลต้องมีเหตุผล + AuditLog entity 'Employee'

const MAX_IMPORT = 500;

const bad = (error: string) => new BadRequestException({ error });
const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

export const EMPLOYEE_ID_TYPES = ['CITIZEN', 'OTHER'] as const;
export type EmployeeIdType = (typeof EMPLOYEE_ID_TYPES)[number];

function text(raw: unknown, label: string, max: number, required = false): string | null {
  if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) {
    if (required) throw bad(`ต้องใส่${label}`);
    return null;
  }
  if (typeof raw !== 'string') throw bad(`${label}ต้องเป็นข้อความ`);
  const value = raw.trim();
  if (value.length > max) throw bad(`${label}ยาวเกิน ${max} ตัวอักษร`);
  return value;
}

function money(raw: unknown, label: string, { positive = false } = {}): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 99_999_999) throw bad(`${label}ต้องเป็นจำนวนเงินตั้งแต่ 0 ขึ้นไป`);
  if (positive && raw <= 0) throw bad(`${label}ต้องมากกว่า 0`);
  return round2(raw);
}

function bool(raw: unknown, label: string): boolean {
  if (typeof raw !== 'boolean') throw bad(`${label}ต้องเป็นจริง/เท็จ`);
  return raw;
}

function date(raw: unknown, label: string): Date | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) throw bad(`${label}ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง`);
  const d = new Date(`${raw}T00:00:00.000Z`);
  if (d.toISOString().slice(0, 10) !== raw) throw bad(`${label}ไม่มีในปฏิทิน`);
  return d;
}

export interface EmployeeInput {
  code?: unknown;
  prefix?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  position?: unknown;
  idType?: unknown;
  idNumber?: unknown;
  birthDate?: unknown;
  startDate?: unknown;
  baseSalary?: unknown;
  socialSecurity?: unknown;
  withholdTax?: unknown;
  otherAllowance?: unknown;
  userId?: unknown;
  note?: unknown;
}

// ตรวจและแปลงข้อมูลพนักงาน (ใช้ทั้งเพิ่มทีละคน แก้ไข และนำเข้า) - ช่องที่ไม่ได้ส่งมาในโหมดแก้ไข (partial) = ไม่แก้
function parseEmployee(dto: EmployeeInput, partial: boolean) {
  const has = (key: keyof EmployeeInput) => !partial || dto[key] !== undefined;
  const out: {
    code?: string;
    prefix?: string | null;
    firstName?: string;
    lastName?: string | null;
    position?: string | null;
    idType?: EmployeeIdType;
    idNumber?: string;
    birthDate?: Date | null;
    startDate?: Date | null;
    baseSalary?: number;
    socialSecurity?: boolean;
    withholdTax?: boolean;
    otherAllowance?: number;
    userId?: string | null;
    note?: string | null;
  } = {};
  if (has('code')) out.code = text(dto.code, 'รหัสพนักงาน', 20, true)!.toUpperCase();
  if (has('prefix')) out.prefix = text(dto.prefix, 'คำนำหน้า', 20);
  if (has('firstName')) out.firstName = text(dto.firstName, 'ชื่อ', 100, true)!;
  if (has('lastName')) out.lastName = text(dto.lastName, 'นามสกุล', 100);
  if (has('position')) out.position = text(dto.position, 'ตำแหน่ง', 100);
  if (has('idType')) {
    if (!EMPLOYEE_ID_TYPES.includes(dto.idType as EmployeeIdType)) throw bad('ประเภทเลขประจำตัวต้องเป็น CITIZEN หรือ OTHER');
    out.idType = dto.idType as EmployeeIdType;
  }
  if (has('idNumber')) {
    // ตัดช่องว่าง/ขีด (คัดลอกจาก Excel) - บัตรประชาชน 13 หลัก ส่วนเลขอื่น (พาสปอร์ต/บัตรต่างด้าว) ขอแค่ไม่ว่าง
    const raw = text(dto.idNumber, 'เลขประจำตัว', 30, true)!.replace(/[\s-]/g, '');
    out.idNumber = raw;
  }
  if (out.idNumber !== undefined) {
    const type = out.idType ?? (dto.idType as EmployeeIdType | undefined);
    if (type === 'CITIZEN' && !/^\d{13}$/.test(out.idNumber)) throw bad('เลขบัตรประชาชนต้องเป็นตัวเลข 13 หลัก (พนักงานต่างชาติเลือกประเภท "เลขอื่น")');
  }
  if (has('birthDate')) {
    out.birthDate = date(dto.birthDate, 'วันเกิด');
    if (out.birthDate && iso(out.birthDate)! > bangkokToday()) throw bad('วันเกิดต้องไม่เกินวันนี้');
  }
  if (has('startDate')) out.startDate = date(dto.startDate, 'วันเริ่มงาน');
  if (has('baseSalary')) out.baseSalary = money(dto.baseSalary, 'เงินเดือน', { positive: true });
  if (has('socialSecurity')) out.socialSecurity = bool(dto.socialSecurity, 'ประกันสังคม');
  if (has('withholdTax')) out.withholdTax = bool(dto.withholdTax, 'หักภาษี');
  if (has('otherAllowance')) out.otherAllowance = dto.otherAllowance === undefined || dto.otherAllowance === null ? 0 : money(dto.otherAllowance, 'ค่าลดหย่อนอื่นๆ');
  if (has('userId')) out.userId = text(dto.userId, 'ผู้ใช้ที่ผูก', 50);
  if (has('note')) out.note = text(dto.note, 'หมายเหตุ', 500);
  return out;
}

type EmployeeRow = {
  id: string;
  code: string;
  prefix: string | null;
  firstName: string;
  lastName: string | null;
  position: string | null;
  idType: string;
  idNumber: string;
  birthDate: Date | null;
  startDate: Date | null;
  baseSalary: unknown;
  socialSecurity: boolean;
  withholdTax: boolean;
  otherAllowance: unknown;
  status: string;
  resignedDate: Date | null;
  userId: string | null;
  note: string | null;
  updatedAt: Date;
  user?: { name: string; email: string } | null;
};

export function fullNameOf(e: { prefix: string | null; firstName: string; lastName: string | null }): string {
  return [e.prefix, e.firstName, e.lastName].filter(Boolean).join(' ');
}

export function mapEmployee(e: EmployeeRow) {
  return {
    id: e.id,
    code: e.code,
    prefix: e.prefix,
    firstName: e.firstName,
    lastName: e.lastName,
    fullName: fullNameOf(e),
    position: e.position,
    idType: e.idType,
    idNumber: e.idNumber,
    birthDate: iso(e.birthDate),
    startDate: iso(e.startDate),
    baseSalary: Number(e.baseSalary),
    socialSecurity: e.socialSecurity,
    withholdTax: e.withholdTax,
    otherAllowance: Number(e.otherAllowance),
    status: e.status,
    resignedDate: iso(e.resignedDate),
    userId: e.userId,
    userLabel: e.user ? `${e.user.name} (${e.user.email})` : null,
    note: e.note,
    updatedAt: e.updatedAt.toISOString(),
  };
}

const INCLUDE = { user: { select: { name: true, email: true } } } as const;

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  // status: ACTIVE | RESIGNED | ไม่ระบุ = ทั้งหมด / q ค้นรหัส ชื่อ ตำแหน่ง (เลขบัตรไม่ค้น กันเลขถูกพิมพ์ลงช่องค้นหาแล้วค้างในประวัติ URL)
  async list(params: { status?: string; q?: string }) {
    const q = params.q?.trim();
    const rows = await this.prisma.employee.findMany({
      where: {
        ...(params.status === 'ACTIVE' || params.status === 'RESIGNED' ? { status: params.status } : {}),
        ...(q
          ? {
              OR: [
                { code: { contains: q, mode: 'insensitive' as const } },
                { firstName: { contains: q, mode: 'insensitive' as const } },
                { lastName: { contains: q, mode: 'insensitive' as const } },
                { position: { contains: q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { code: 'asc' },
      include: INCLUDE,
    });
    return { employees: rows.map(mapEmployee) };
  }

  async create(dto: EmployeeInput) {
    const data = parseEmployee(dto, false);
    await this.assertUnique(data.code!, data.idNumber!);
    await this.assertUserFree(data.userId ?? null, null);
    const row = await this.prisma.employee.create({ data: data as Prisma.EmployeeUncheckedCreateInput, include: INCLUDE });
    return mapEmployee(row);
  }

  // นำเข้าหลายคน (วางจาก Excel): รหัสหรือเลขประจำตัวซ้ำกับที่มีอยู่ = ข้าม (ไม่ทับข้อมูลเดิม) แล้วรายงานเหตุผลรายแถว
  // ข้อมูลไม่ถูกต้องแม้แถวเดียว = ไม่บันทึกเลยทั้งชุด (ให้แก้แล้วส่งใหม่ ไม่ต้องไล่ดูว่าเข้าไปแล้วกี่แถว)
  async importMany(dto: { rows?: unknown }) {
    if (!Array.isArray(dto?.rows) || dto.rows.length === 0) throw bad('ไม่มีรายการให้นำเข้า');
    if (dto.rows.length > MAX_IMPORT) throw bad(`ครั้งละไม่เกิน ${MAX_IMPORT} คน`);
    const parsed = (dto.rows as EmployeeInput[]).map((row, i) => {
      try {
        return { index: i, data: parseEmployee(row ?? {}, false) };
      } catch (err) {
        const message = err instanceof BadRequestException ? ((err.getResponse() as { error?: string }).error ?? 'ข้อมูลไม่ถูกต้อง') : 'ข้อมูลไม่ถูกต้อง';
        throw bad(`แถวที่ ${i + 1}: ${message}`);
      }
    });
    const seenCode = new Set<string>();
    const seenId = new Set<string>();
    for (const { index, data } of parsed) {
      if (seenCode.has(data.code!)) throw bad(`แถวที่ ${index + 1}: รหัส ${data.code} ซ้ำในรายการที่วาง`);
      if (seenId.has(data.idNumber!)) throw bad(`แถวที่ ${index + 1}: เลขประจำตัวซ้ำในรายการที่วาง`);
      seenCode.add(data.code!);
      seenId.add(data.idNumber!);
    }
    const existing = await this.prisma.employee.findMany({
      where: { OR: [{ code: { in: [...seenCode] } }, { idNumber: { in: [...seenId] } }] },
      select: { code: true, idNumber: true },
    });
    const takenCode = new Set(existing.map((e) => e.code));
    const takenId = new Set(existing.map((e) => e.idNumber));
    const skipped: Array<{ code: string; reason: string }> = [];
    const toCreate = parsed.filter(({ data }) => {
      if (takenCode.has(data.code!)) skipped.push({ code: data.code!, reason: 'มีรหัสนี้ในระบบแล้ว' });
      else if (takenId.has(data.idNumber!)) skipped.push({ code: data.code!, reason: 'มีเลขประจำตัวนี้ในระบบแล้ว' });
      else return true;
      return false;
    });
    if (toCreate.length) {
      await this.prisma.employee.createMany({ data: toCreate.map(({ data }) => ({ ...data, userId: null }) as Prisma.EmployeeCreateManyInput) });
    }
    return { created: toCreate.length, skipped };
  }

  // แก้ข้อมูล: เหตุผลบังคับ + ประวัติ (เงินเดือนเปลี่ยนก็อยู่ในนี้) / expectedUpdatedAt กันแก้ทับกันเมื่อเปิดหน้าไว้นาน
  async update(id: string, dto: EmployeeInput & { remark?: unknown; expectedUpdatedAt?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่แก้ข้อมูลพนักงาน');
    if (remark.length > 500) throw bad('เหตุผลยาวเกิน 500 ตัวอักษร');
    const data = parseEmployee(dto, true);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.employee.findUnique({ where: { id } });
      if (!before) throw new NotFoundException({ error: 'ไม่พบพนักงาน' });
      if (typeof dto.expectedUpdatedAt === 'string' && dto.expectedUpdatedAt !== before.updatedAt.toISOString()) {
        throw new ConflictException({ error: 'ข้อมูลพนักงานนี้ถูกแก้ไปแล้ว กรุณาโหลดใหม่' });
      }
      // เปลี่ยนแค่ประเภทหรือแค่เลข ก็ต้องเข้ากันกับของที่เหลือ (บัตรประชาชน = 13 หลัก)
      const idType = data.idType ?? before.idType;
      const idNumber = data.idNumber ?? before.idNumber;
      if (idType === 'CITIZEN' && !/^\d{13}$/.test(idNumber)) throw bad('เลขบัตรประชาชนต้องเป็นตัวเลข 13 หลัก (พนักงานต่างชาติเลือกประเภท "เลขอื่น")');
      if (data.code !== undefined || data.idNumber !== undefined) {
        await this.assertUnique(data.code ?? before.code, data.idNumber ?? before.idNumber, id, tx);
      }
      if (data.userId !== undefined) await this.assertUserFree(data.userId, id, tx);
      const changes = diffChanges(before, data);
      if (!Object.keys(changes).length) throw bad('ไม่มีข้อมูลที่เปลี่ยน');
      const row = await tx.employee.update({ where: { id }, data, include: INCLUDE });
      await writeAudit(tx, { entity: 'Employee', entityId: id, action: 'update', remark, changes });
      return mapEmployee(row);
    });
  }

  async resign(id: string, dto: { date?: unknown; remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่ลาออก/พ้นสภาพ');
    const resignedDate = date(dto.date, 'วันที่ลาออก');
    if (!resignedDate) throw bad('ต้องใส่วันที่ลาออก');
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.employee.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'RESIGNED', resignedDate } });
      if (count === 0) {
        if (!(await tx.employee.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException({ error: 'ไม่พบพนักงาน' });
        throw new ConflictException({ error: 'พนักงานคนนี้ลาออกไปแล้ว กรุณาโหลดใหม่' });
      }
      await writeAudit(tx, { entity: 'Employee', entityId: id, action: 'resign', remark, changes: { status: { from: 'ACTIVE', to: 'RESIGNED' }, resignedDate: { from: null, to: resignedDate } } });
      return mapEmployee((await tx.employee.findUnique({ where: { id }, include: INCLUDE }))!);
    });
  }

  async reinstate(id: string, dto: { remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่รับกลับเข้าทำงาน');
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.employee.findUnique({ where: { id }, select: { resignedDate: true } });
      if (!before) throw new NotFoundException({ error: 'ไม่พบพนักงาน' });
      const { count } = await tx.employee.updateMany({ where: { id, status: 'RESIGNED' }, data: { status: 'ACTIVE', resignedDate: null } });
      if (count === 0) throw new ConflictException({ error: 'พนักงานคนนี้ทำงานอยู่แล้ว กรุณาโหลดใหม่' });
      await writeAudit(tx, { entity: 'Employee', entityId: id, action: 'reinstate', remark, changes: { status: { from: 'RESIGNED', to: 'ACTIVE' }, resignedDate: { from: before.resignedDate, to: null } } });
      return mapEmployee((await tx.employee.findUnique({ where: { id }, include: INCLUDE }))!);
    });
  }

  async history(id: string) {
    const logs = await this.prisma.auditLog.findMany({
      where: { entity: 'Employee', entityId: id },
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

  private async assertUnique(code: string, idNumber: string, exceptId?: string, db: Pick<PrismaService, 'employee'> = this.prisma) {
    const clash = await db.employee.findFirst({
      where: { OR: [{ code }, { idNumber }], ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { code: true, idNumber: true },
    });
    if (clash) throw new ConflictException({ error: clash.code === code ? `รหัสพนักงาน ${code} มีในระบบแล้ว` : 'เลขประจำตัวนี้มีพนักงานอื่นใช้อยู่แล้ว' });
  }

  private async assertUserFree(userId: string | null, exceptEmployeeId: string | null, db: Pick<PrismaService, 'employee' | 'user'> = this.prisma) {
    if (!userId) return;
    if (!(await db.user.findUnique({ where: { id: userId }, select: { id: true } }))) throw bad('ไม่พบผู้ใช้ที่จะผูก');
    const clash = await db.employee.findFirst({ where: { userId, ...(exceptEmployeeId ? { id: { not: exceptEmployeeId } } : {}) }, select: { code: true } });
    if (clash) throw new ConflictException({ error: `ผู้ใช้นี้ผูกกับพนักงาน ${clash.code} อยู่แล้ว` });
  }
}
