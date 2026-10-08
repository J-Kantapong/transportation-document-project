import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { SupplierRatesService, type SupplierRateInput } from './supplier-rates.service.js';

// อ่าน = พนักงานทุกฝ่าย (หน้าเพิ่มข้อมูลรถเตือนจังหวัดที่ซับไม่รับ / หน้ายื่นเอกสารแสดงค่าจ้างซับ) เขียน = ADMIN (ดู access-policy.ts)
@Controller('api/supplier-rates')
export class SupplierRatesController {
  constructor(private readonly service: SupplierRatesService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get('history')
  history(@Query('province') province: string) {
    return this.service.history(province);
  }

  @Post()
  save(@Body() body: SupplierRateInput) {
    return this.service.save(body);
  }
}
