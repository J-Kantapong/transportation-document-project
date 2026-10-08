import { Controller, Get, Query } from '@nestjs/common';
import { ActivityService } from './activity.service.js';

@Controller('api/activity')
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  // ?date=YYYY-MM-DD (ไม่ใส่ = วันนี้ตามเวลาไทย) - ADMIN เท่านั้น (มีราคา) ดู access-policy.ts
  @Get()
  day(@Query('date') date?: string) {
    return this.activityService.day(date);
  }
}
