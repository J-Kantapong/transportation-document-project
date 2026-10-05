import { ConflictException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';

// รายการแจ้งย้ายยามาฮ่าของเดือนที่มีใบเสนอราคาใช้อยู่ถูกล็อก (ผู้ใช้ 2026-10-01): เพิ่ม/แก้/ยกเลิกไม่ได้จนกว่าจะยกเลิกใบเสนอราคา
// ไม่งั้นยอดในระบบจะไม่ตรงกับยอดที่เสนอราคาและวางบิลไปแล้ว (แก้ยอด = ยกเลิกใบเสนอราคา -> แก้รายการ -> ออกใบใหม่)
// รถเล็กกับรถใหญ่ออกใบเสนอราคาคนละใบ (ผู้ใช้ 2026-10-05) - ล็อกเฉพาะขนาดที่ตรงกับรายการ · ใบเก่าที่ไม่ระบุขนาด (null) ล็อกทั้งสองขนาด
export async function assertYamahaMonthNotQuoted(db: Pick<Prisma.TransactionClient, 'quotation'>, entries: Array<{ date: Date; size: string }>): Promise<void> {
  const keys = [...new Map(entries.map((e) => [`${e.date.toISOString().slice(0, 7)}|${e.size}`, { month: e.date.toISOString().slice(0, 7), size: e.size }])).values()];
  const quoted = await db.quotation.findFirst({
    where: {
      status: { in: ['ISSUED', 'APPROVED'] },
      OR: keys.map((k) => ({ yamahaMonth: k.month, OR: [{ yamahaSize: k.size }, { yamahaSize: null }] })),
    },
    select: { quotationNo: true, yamahaMonth: true, yamahaSize: true },
  });
  if (quoted) {
    const m = quoted.yamahaMonth!;
    const sizeText = quoted.yamahaSize === 'LARGE' ? ' (รถใหญ่)' : quoted.yamahaSize === 'SMALL' ? ' (รถเล็ก)' : '';
    throw new ConflictException({
      error: `งานแจ้งย้ายเดือน ${m.slice(5, 7)}/${m.slice(0, 4)}${sizeText} ออกใบเสนอราคา ${quoted.quotationNo} ไปแล้ว ยอดนี้ถูกล็อก - ต้องยกเลิกใบเสนอราคาก่อนจึงจะแก้รายการได้`,
    });
  }
}
