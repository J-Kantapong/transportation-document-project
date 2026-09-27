import { BadRequestException, ConflictException } from '@nestjs/common';
import { bangkokToday } from '../overview/overview-calculator.js';

// วันที่รับป้าย/รับเล่ม (Step 6/7) ที่พนักงานพิมพ์ในแถวคิวแล้วส่งมากับรูป - ใช้ร่วมกันระหว่าง plate-photos และ book-photos
// รับเฉพาะ ค.ศ. YYYY-MM-DD ที่มีจริงในปฏิทิน (31/02 ไม่ผ่าน)
export function parseReceivedDate(raw: unknown): Date {
  const date = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00.000Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || !date.toISOString().startsWith(raw as string)) {
    throw new BadRequestException({ error: 'วันที่ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
  }
  return date;
}

export const isoDay = (date: Date) => date.toISOString().slice(0, 10);
export const dmyOf = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// วันที่รับต้องไม่ก่อนวันที่ในใบเสร็จของการยื่นล่าสุด (ไม่มี = วันที่ยื่น) และไม่เกินวันนี้ตามเวลาไทย
// (พบ 2026-09-27: เดิมตรวจแค่รูปแบบ พิมพ์ปีผิดหรือวันในอนาคตก็บันทึกได้ และแก้ย้อนหลังไม่ได้)
// หน้าเว็บตรวจแบบเดียวกันก่อนอัปโหลด (ReceivingQueuePage) - label เช่น "วันที่รับป้าย"
export function assertReceivedDateInRange(
  label: string,
  date: Date,
  submission: { submitDate: Date; receiptDate: Date | null } | undefined,
  today: string = bangkokToday(),
): void {
  const iso = isoDay(date);
  if (submission) {
    const earliest = isoDay(submission.receiptDate ?? submission.submitDate);
    if (iso < earliest) {
      const from = submission.receiptDate ? 'วันที่ในใบเสร็จ' : 'วันที่ยื่นเอกสาร';
      throw new BadRequestException({ error: `${label}ต้องไม่ก่อน${from} (${dmyOf(earliest)})` });
    }
  }
  if (iso > today) throw new BadRequestException({ error: `${label}ต้องไม่เกินวันนี้` });
}

// แก้วันที่รับ / ถอดรูปป้าย-เล่มที่แนบผิด ต้องมีเหตุผลทุกครั้ง (ผู้ใช้ 2026-09-27) - เก็บลง VehicleEditLog
export function parseFixRemark(raw: unknown, action: string): string {
  const remark = typeof raw === 'string' ? raw.trim() : '';
  if (!remark) throw new BadRequestException({ error: `กรุณาระบุเหตุผลที่${action}` });
  return remark;
}

// แก้ได้เฉพาะก่อนส่งของให้ลูกค้า (ผู้ใช้ 2026-09-27) - ส่งแล้วต้องยกเลิกใบส่งงานก่อน (หน้ารายงานส่งงาน) ใบส่งงานจะได้ไม่ขัดกับข้อมูลรถ
// item เช่น "ป้าย" / "เล่ม"
export function assertNotDeliveredYet(item: string, deliveredDate: Date | null): void {
  if (!deliveredDate) return;
  throw new BadRequestException({
    error: `ส่ง${item}ให้ลูกค้าไปแล้ว (${dmyOf(isoDay(deliveredDate))}) - ยกเลิกใบส่งงานนั้นก่อนที่หน้ารายงานส่งงาน แล้วจึงแก้ได้`,
  });
}

// อีกเครื่องเพิ่งเปลี่ยนข้อมูลรับป้าย/เล่มของรถคันนี้ระหว่างที่แก้ (updateMany ที่มีเงื่อนไขรูปเดิมไม่เจอแถว)
// หน้าเว็บโหลดรายการใหม่ให้เองเมื่อได้ 409/400 (ไม่ต้องโหลดทั้งหน้า วันที่ที่พิมพ์ไว้ในคิวจะได้ไม่หาย - พบ 2026-09-27)
export function staleReceivedRow(): ConflictException {
  return new ConflictException({ error: 'ข้อมูลรถคันนี้เพิ่งถูกเปลี่ยน (ส่งงานหรือแก้จากเครื่องอื่น) - รายการโหลดใหม่แล้ว ตรวจดูแล้วลองอีกครั้ง' });
}

// ผลของการถอดรูป: deleted = ลบรูปแล้ว (แนบไฟล์เดิมให้คันที่ถูกได้), shared = รูปเก่าจากถาด AI ยังเป็นรูปของรถคันอื่น
// จึงไม่ลบ (ไฟล์เดิมแนบซ้ำไม่ได้ ต้องถ่ายใหม่), none = แถวเก่าที่รับโดยไม่มีรูป (พบ 2026-09-27)
export type DetachedPhoto = 'deleted' | 'shared' | 'none';
