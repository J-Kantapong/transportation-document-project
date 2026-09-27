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
  // + แก้งานที่บันทึกผิด (ข้อมูลรถ/ภาษี, แก้หรือล้างวันที่ที่มีแล้ว) ต้องส่ง remark (ผู้ใช้ 2026-09-27)
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.taxRenewalService.update(id, body ?? {});
  }

  // ยกเลิกงาน { remark } - แถวยังอยู่ (cancelledAt) แต่ไม่แสดงในรายการ ยอดรวม และภาพรวม (ผู้ใช้ 2026-09-27)
  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return this.taxRenewalService.cancel(id, body?.remark);
  }
}
