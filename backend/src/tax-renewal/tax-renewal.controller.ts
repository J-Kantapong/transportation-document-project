import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { TaxRenewalService } from './tax-renewal.service.js';

@Controller('api/tax-renewals')
export class TaxRenewalController {
  constructor(private readonly taxRenewalService: TaxRenewalService) {}

  @Get()
  findAll() {
    return this.taxRenewalService.findAll();
  }

  // ค้นรถมาต่อภาษี - เลขตัวถัง / เลขเครื่อง / เลขทะเบียน / ชื่อลูกค้า / ผู้ถือกรรมสิทธิ์ / ผู้ครอบครอง
  @Get('vehicle-search')
  async searchVehicles(@Query('q') q = '') {
    return { vehicles: await this.taxRenewalService.searchVehicles(q) };
  }

  // คิดยอดภาษี + ค่าใช้จ่ายให้ฟอร์มดูสดๆ ไม่บันทึกอะไร
  @Post('preview')
  preview(@Body() body: Record<string, unknown>) {
    return this.taxRenewalService.preview(body);
  }

  @Post()
  create(@Body() body: Record<string, unknown>) {
    return this.taxRenewalService.create(body);
  }

  // เติมวันที่ชำระ/รับป้าย/คืนลูกค้า และติ๊ก ตรอ./พ.ร.บ. จากหน้ารายการ
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.taxRenewalService.update(id, body);
  }
}
