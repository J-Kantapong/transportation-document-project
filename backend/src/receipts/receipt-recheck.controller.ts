import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { isRecheckJobType, recheckJobs } from './receipt-recheck.js';

// ผลตรวจใบเสร็จซ้ำของงานรถเก่า (ผู้ใช้ 2026-11-19) - หน้ารับใบเสร็จเรียกทีละหน้า ไม่แก้ข้อมูล
// GET /api/receipts/recheck?type=PLATE_SWAP|TRANSFER|USE_CANCEL|MOVE_OUT|PLATE_COPY|TAX_RENEWAL&ids=a,b,c -> { checks: { [id]: ReceiptRecheck } }
// สิทธิ์ = กฎ GET ของ /api/receipts (กลุ่มยื่นเอกสาร + บัญชี) ใน access-policy.ts
@Controller('api/receipts/recheck')
export class ReceiptRecheckController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async recheck(@Query('type') type?: string, @Query('ids') idsRaw?: string) {
    if (!isRecheckJobType(type)) throw new BadRequestException({ error: 'type ไม่ถูกต้อง' });
    const ids = [...new Set((idsRaw ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
    if (ids.length > 500) throw new BadRequestException({ error: 'ขอได้ครั้งละไม่เกิน 500 งาน' });
    return { checks: Object.fromEntries(await recheckJobs(this.prisma, type, ids)) };
  }
}
