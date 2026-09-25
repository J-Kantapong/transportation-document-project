import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';

// เงื่อนไขค้นหารถที่ใช้ร่วมกันระหว่างรายการในหน้าเพิ่มข้อมูลรถจดใหม่ (GET /api/vehicles) และหน้าค้นหารถ
// (GET /api/vehicle-search) - q ค้นจากเลขตัวถัง / เลขเครื่อง / ทะเบียน / ชื่อลูกค้า / ผู้ถือกรรมสิทธิ์ / ผู้ครอบครอง
// from/to (ค.ศ. YYYY-MM-DD รวมวันปลายทั้งสองด้าน) กรอง "วันที่" ของรถ (Vehicle.date) - ไม่รวมรถที่ถูกลบ

function parseDateParam(raw: string | undefined, name: string): Date | null {
  const value = raw?.trim();
  if (!value) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  // วันที่ที่ไม่มีจริง (เดือน 13, 31 ก.พ.) ต้องตอบ 400 - toISOString() ของ Invalid Date โยน error จึงเช็ค getTime() ก่อน
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  if (!valid) throw new BadRequestException({ error: `${name} ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง` });
  return date;
}

export function vehicleListWhere(params: { q?: string; from?: string; to?: string }): Prisma.VehicleWhereInput {
  const q = params.q?.trim() ?? '';
  const from = parseDateParam(params.from, 'from');
  const to = parseDateParam(params.to, 'to');

  const where: Prisma.VehicleWhereInput = { deletedAt: null };
  if (from || to) where.date = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  if (q) {
    const contains = { contains: q, mode: 'insensitive' as const };
    const or: Prisma.VehicleWhereInput[] = [
      { chassis: contains },
      { engine: contains },
      { plateCategory: contains },
      { plateNumber: contains },
      { customer: { name: contains } },
      { customer: { company: contains } },
      { owner: { name: contains } },
      { owner: { hirerName: contains } },
    ];
    // ทะเบียนพิมพ์ติดกัน เช่น "4กข4444" / "4กข 4444" = หมวด + เลขท้าย
    const plate = q.replace(/[\s-]/g, '').match(/^(.*\D)(\d{1,4})$/);
    if (plate) or.push({ plateCategory: { contains: plate[1], mode: 'insensitive' }, plateNumber: plate[2] });
    where.OR = or;
  }
  return where;
}
