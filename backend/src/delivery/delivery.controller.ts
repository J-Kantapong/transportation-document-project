import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
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

  @Post()
  submit(@Body() body: { vehicleIds?: unknown; date?: unknown; recipient?: unknown; note?: unknown }) {
    return this.deliveryService.submit(body);
  }
}
