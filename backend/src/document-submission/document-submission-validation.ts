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

// ตาม mockup: ถ้าเลือกขอใช้เลขทะเบียน (NORMAL/AUCTION) ต้องกรอกหมวดทะเบียน+เลขทะเบียนก่อนบันทึกจริง
// (ต่างจากกรณี "ไม่ขอ" ที่เว้นว่างได้ เพราะกรมขนส่งรันเลขให้เองแล้วมากรอกทีหลัง)
export function assertPlateNumberProvided(plateNumberOption: PlateNumberOption, plateCategory: string | null, plateNumber: string | null) {
  if (plateNumberOption !== 'NONE' && (!plateCategory || !plateNumber)) {
    throw new BadRequestException({ error: 'กรุณากรอกหมวดทะเบียนและเลขทะเบียนที่ขอก่อนบันทึก' });
  }
}
