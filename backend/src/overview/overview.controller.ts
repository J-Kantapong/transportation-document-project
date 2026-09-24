import { Controller, Get, Query } from '@nestjs/common';
import { OverviewService } from './overview.service.js';

@Controller('api/overview')
export class OverviewController {
  constructor(private readonly overviewService: OverviewService) {}

  // ?date=YYYY-MM-DD = วันที่ที่ต้องการดูสรุปรายวัน (ไม่ใส่ = วันนี้ตามเวลาไทย) - งานค้าง/ลูกหนี้/ประมาณการเป็นข้อมูลสด ณ ตอนนี้เสมอ
  @Get()
  overview(@Query('date') date?: string) {
    return this.overviewService.overview(date);
  }
}
