import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { DeliveryService } from './delivery.service.js';

@Controller('api/delivery')
export class DeliveryController {
  constructor(private readonly deliveryService: DeliveryService) {}

  @Get('queue')
  async queue() {
    const vehicles = await this.deliveryService.queue();
    // lotVehicles = คันอื่นในใบยื่นเดียวกันที่ยังไม่พร้อมส่งหรือส่งครบแล้ว (แสดงอย่างเดียว ติ๊กไม่ได้)
    return { vehicles, lotVehicles: await this.deliveryService.lotVehicles(vehicles) };
  }

  @Get('recent')
  async recent() {
    return { vehicles: await this.deliveryService.recent() };
  }

  // ใบส่งงาน / รายงานส่งงานย้อนหลัง - ?from=YYYY-MM-DD&to=YYYY-MM-DD&customerId=
  @Get('slips')
  async slips(@Query() query: { from?: string; to?: string; customerId?: string }) {
    return { slips: await this.deliveryService.slips(query) };
  }

  @Get('slips/:id')
  slip(@Param('id') id: string) {
    return this.deliveryService.slip(id);
  }

  // แก้ / ยกเลิกใบส่งงานที่คีย์ผิด (ผู้ใช้ 2026-09-26) - ต้องมีเหตุผล, ADMIN / STAFF_CAR / STAFF_MOTO ตามประเภทรถ (DELIVERY ทำไม่ได้)
  @Patch('slips/:id')
  updateSlip(@Param('id') id: string, @Body() body: { recipient?: unknown; date?: unknown; remark?: unknown }) {
    return this.deliveryService.updateSlip(id, body);
  }

  @Post('slips/:id/cancel')
  cancelSlip(@Param('id') id: string, @Body() body: { vehicleIds?: unknown; remark?: unknown }) {
    return this.deliveryService.cancelSlip(id, body);
  }

  @Post()
  submit(@Body() body: { vehicleIds?: unknown; date?: unknown; recipient?: unknown; note?: unknown }) {
    return this.deliveryService.submit(body);
  }
}
