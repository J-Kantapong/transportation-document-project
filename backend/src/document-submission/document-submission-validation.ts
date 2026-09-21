// Hand-rolled validation matching the convention in tax/tax-validation.ts and
// vehicles/vehicle-validation.ts (plain functions + Thai error messages, no class-validator).
import { BadRequestException } from '@nestjs/common';
import type { DocumentSubmissionOptionsInput, NewPlateOption, PlateNumberOption } from './document-fee-calculator.js';

const PLATE_NUMBER_OPTIONS: PlateNumberOption[] = ['NONE', 'NORMAL', 'AUCTION'];
const NEW_PLATE_OPTIONS: NewPlateOption[] = ['NONE', 'BLACKWHITE', 'AUCTION'];

export function parseDocumentSubmissionOptions(raw: unknown, isMoto: boolean): DocumentSubmissionOptionsInput {
  if (!raw || typeof raw !== 'object') throw new BadRequestException({ error: 'กรุณาระบุตัวเลือกค่าธรรมเนียม' });
  const body = raw as Record<string, unknown>;

  const plateNumberOption = body.plateNumberOption;
  if (!PLATE_NUMBER_OPTIONS.includes(plateNumberOption as PlateNumberOption)) {
    throw new BadRequestException({ error: 'plateNumberOption ต้องเป็น NONE, NORMAL หรือ AUCTION' });
  }
  if (isMoto && plateNumberOption === 'AUCTION') {
    throw new BadRequestException({ error: 'มอเตอร์ไซค์มีค่าขอใช้เลขทะเบียนราคาเดียว ไม่มีตัวเลือกเลขประมูล' });
  }

  const includePlateFee = body.includePlateFee === undefined ? true : Boolean(body.includePlateFee);

  let newPlateOption: NewPlateOption | null = null;
  if (!isMoto) {
    const newPlateRaw = body.newPlateOption ?? 'NONE';
    if (!NEW_PLATE_OPTIONS.includes(newPlateRaw as NewPlateOption)) {
      throw new BadRequestException({ error: 'newPlateOption ต้องเป็น NONE, BLACKWHITE หรือ AUCTION' });
    }
    newPlateOption = newPlateRaw as NewPlateOption;
  }

  const relocateAddon = !isMoto && Boolean(body.relocateAddon);
  const stopUseRelocateOut = isMoto && Boolean(body.stopUseRelocateOut);
  const urgent = Boolean(body.urgent);

  return {
    plateNumberOption: plateNumberOption as PlateNumberOption,
    includePlateFee,
    newPlateOption,
    relocateAddon,
    stopUseRelocateOut,
    urgent,
  };
}

export function parseSubmitDate(raw: unknown): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw new BadRequestException({ error: 'submitDate ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

export function parsePlateFields(raw: unknown, field: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new BadRequestException({ error: `${field} ต้องเป็นข้อความ` });
  const trimmed = raw.trim();
  return trimmed || null;
}

// รูปแบบเดียวกับช่องกรอกฝั่งหน้าเว็บ: หมวดทะเบียนสูงสุด 3 ตัวอักษร (เช่น "4กข"), เลขทะเบียน 1-4 หลัก (เช่น "4444")
export function assertPlateFormat(plateCategory: string, plateNumber: string) {
  if (plateCategory.length > 3) throw new BadRequestException({ error: 'หมวดทะเบียนต้องไม่เกิน 3 ตัวอักษร' });
  if (!/^\d{1,4}$/.test(plateNumber)) throw new BadRequestException({ error: 'เลขทะเบียนต้องเป็นตัวเลข 1-4 หลัก' });
}

// ยอดเงินบนใบเสร็จ: ว่าง = ไม่ระบุ (null), ไม่งั้นต้องเป็นตัวเลขไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง
export function parseReceiptAmount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new BadRequestException({ error: 'ยอดใบเสร็จต้องเป็นตัวเลขตั้งแต่ 0 ทศนิยมไม่เกิน 2 ตำแหน่ง' });
  return Number(text);
}

// เลขที่ใบเสร็จไม่บังคับ และไม่ล็อกรูปแบบ (ผู้ใช้: prefix น่าจะเป็นปี พ.ศ. เปลี่ยนทุกปี - UI แค่เตือนถ้าไม่ใช่ ตัวเลข/ตัวเลข)
export function parseReceiptNo(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new BadRequestException({ error: 'เลขที่ใบเสร็จต้องเป็นข้อความ' });
  const text = raw.trim();
  if (text.length > 30) throw new BadRequestException({ error: 'เลขที่ใบเสร็จยาวเกิน 30 ตัวอักษร' });
  return text || null;
}

// ตาม mockup: ถ้าเลือกขอใช้เลขทะเบียน (NORMAL/AUCTION) ต้องกรอกหมวดทะเบียน+เลขทะเบียนก่อนบันทึกจริง
// (ต่างจากกรณี "ไม่ขอ" ที่เว้นว่างได้ เพราะกรมขนส่งรันเลขให้เองแล้วมากรอกทีหลัง)
export function assertPlateNumberProvided(plateNumberOption: PlateNumberOption, plateCategory: string | null, plateNumber: string | null) {
  if (plateNumberOption !== 'NONE' && (!plateCategory || !plateNumber)) {
    throw new BadRequestException({ error: 'กรุณากรอกหมวดทะเบียนและเลขทะเบียนที่ขอก่อนบันทึก' });
  }
}
