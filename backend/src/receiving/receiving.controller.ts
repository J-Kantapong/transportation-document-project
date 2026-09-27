import { Controller, Get, Param, Query } from '@nestjs/common';
import { ReceivingService } from './receiving.service.js';

// PATCH ':id/receiving/:step' (ติ๊กรับ/ส่งเอง) ถูกถอดออก (พบ 2026-09-27): รับป้าย/เล่มต้องแนบรูป (/api/plate-photos, /api/book-photos)
// และส่งงานต้องออกใบส่งงานที่ POST /api/delivery - เส้นเดิมบันทึกส่งงานโดยไม่มีใบส่งงานและไม่ตรวจว่าวางบิลแล้ว
@Controller('api/vehicles')
export class ReceivingController {
  constructor(private readonly receivingService: ReceivingService) {}

  // ?kind=car|moto (ไม่ส่ง = ทุกประเภทในขอบเขตของผู้ใช้)
  @Get('receiving/:step/pending')
  async listPending(@Param('step') step: string, @Query('kind') kind?: string) {
    return { vehicles: await this.receivingService.listPending(step, kind) };
  }

  // ?kind=car|moto&q=&offset=&limit= -> { vehicles, hasMore } ทีละ 100 คัน (limit ได้ถึง 1,000) ล่าสุดที่แนบก่อน
  @Get('receiving/:step/completed')
  listCompleted(@Param('step') step: string, @Query() query: { kind?: string; q?: string; offset?: string; limit?: string }) {
    return this.receivingService.listCompleted(step, query ?? {});
  }
}
