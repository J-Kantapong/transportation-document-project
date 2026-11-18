import { Body, Controller, Get, Post } from '@nestjs/common';
import { TransferContributionRatesService, type ContributionRateInput } from './transfer-contribution-rates.service.js';

// ลงขันงานโอนรายจังหวัด (ผู้ใช้ 2026-11-18) - อ่าน = กลุ่มยื่นเอกสาร + บัญชี (ฟอร์มงานโอนใช้เติมค่าตั้งต้น) เขียน = ADMIN (ดู access-policy.ts)
@Controller('api/transfer-contribution-rates')
export class TransferContributionRatesController {
  constructor(private readonly service: TransferContributionRatesService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  // { province, transferMoto, transferCar, moveInMoto, note, remark?, expectedUpdatedAt } - ช่องว่าง = ยังไม่ตั้งอัตรา
  @Post()
  save(@Body() body: ContributionRateInput) {
    return this.service.save(body);
  }
}
