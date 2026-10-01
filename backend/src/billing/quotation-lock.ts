import { ConflictException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';

// รายการแจ้งย้ายยามาฮ่าของเดือนที่มีใบเสนอราคาใช้อยู่ถูกล็อก (ผู้ใช้ 2026-10-01): เพิ่ม/แก้/ยกเลิกไม่ได้จนกว่าจะยกเลิกใบเสนอราคา
// ไม่งั้นยอดในระบบจะไม่ตรงกับยอดที่เสนอราคาและวางบิลไปแล้ว (แก้ยอด = ยกเลิกใบเสนอราคา -> แก้รายการ -> ออกใบใหม่)
export async function assertYamahaMonthNotQuoted(db: Pick<Prisma.TransactionClient, 'quotation'>, dates: Date[]): Promise<void> {
  const months = [...new Set(dates.map((d) => d.toISOString().slice(0, 7)))];
  const quoted = await db.quotation.findFirst({
    where: { yamahaMonth: { in: months }, status: { in: ['ISSUED', 'APPROVED'] } },
    select: { quotationNo: true, yamahaMonth: true },
  });
  if (quoted) {
    const m = quoted.yamahaMonth!;
    throw new ConflictException({
      error: `งานแจ้งย้ายเดือน ${m.slice(5, 7)}/${m.slice(0, 4)} ออกใบเสนอราคา ${quoted.quotationNo} ไปแล้ว ยอดของเดือนนี้ถูกล็อก - ต้องยกเลิกใบเสนอราคาก่อนจึงจะแก้รายการได้`,
    });
  }
}
