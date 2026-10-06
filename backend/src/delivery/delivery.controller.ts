import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { DeliverySheetService } from './delivery-sheet.service.js';
import { DeliveryService } from './delivery.service.js';

@Controller('api/delivery')
export class DeliveryController {
  constructor(
    private readonly deliveryService: DeliveryService,
    private readonly deliverySheetService: DeliverySheetService,
  ) {}

  @Get('queue')
  async queue() {
    const vehicles = await this.deliveryService.queue();
    // lotVehicles = คันอื่นในใบยื่นเดียวกันที่ยังไม่พร้อมส่งหรือส่งครบแล้ว (แสดงอย่างเดียว ติ๊กไม่ได้)
    // ทุกแถว (queue / recent / plate-pending) มี customer { id, name, company, branch } ไว้แยกลูกค้าชื่อซ้ำ (F47 2026-09-27)
    return { vehicles, lotVehicles: await this.deliveryService.lotVehicles(vehicles) };
  }

  @Get('recent')
  async recent() {
    return { vehicles: await this.deliveryService.recent() };
  }

  // รายงานส่งงาน: รถที่ส่งเล่มแล้วแต่ป้ายค้างส่ง -> { vehicles } (แถวแบบเดียวกับคิว) ขอบเขตการอ่านเดียวกับ GET slips
  @Get('plate-pending')
  async platePending() {
    return { vehicles: await this.deliveryService.platePending() };
  }

  // ใบส่งงาน / รายงานส่งงานย้อนหลัง - ?from=YYYY-MM-DD&to=YYYY-MM-DD&customerId= -> { slips, truncated } (truncated = เกินเพดาน)
  // ใบละ hiddenItems = คันที่ยังไม่ยกเลิกแต่อยู่นอกขอบเขตการอ่านของผู้ใช้ (ใบเก่าที่รวมรถยนต์ + จักรยานยนต์)
  // GET slips / plate-pending: ACCOUNTANT อ่านได้ด้วย (ผู้ใช้ 2026-09-27) - คิว/บันทึก/แก้ไม่ได้ (access-policy.ts)
  @Get('slips')
  slips(@Query() query: { from?: string; to?: string; customerId?: string }) {
    return this.deliveryService.slips(query);
  }

  // ใบส่งงานรวมทุกประเภท (ผู้ใช้ 2026-10-05) - ?from&to&customerId= -> { rows, truncated } อ่านอย่างเดียว ดู delivery-sheet.service.ts
  @Get('sheet')
  sheet(@Query() query: { from?: string; to?: string; customerId?: string }) {
    return this.deliverySheetService.sheet(query);
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
  cancelSlip(@Param('id') id: string, @Body() body: { itemIds?: unknown; vehicleIds?: unknown; remark?: unknown }) {
    return this.deliveryService.cancelSlip(id, body);
  }

  // ป้ายไปพร้อมเล่มแล้ว (ผู้ใช้ 2026-09-27): ติ๊กป้ายในใบส่งเล่มเดิม - สิทธิ์เดียวกับแก้/ยกเลิกใบ, remark ไม่บังคับ
  @Post('slips/:id/add-plate')
  addPlate(@Param('id') id: string, @Body() body: { itemId?: unknown; source?: unknown; id?: unknown; vehicleId?: unknown; remark?: unknown }) {
    return this.deliveryService.addPlate(id, body);
  }

  // items = [{ vehicleId, kind }] ตามที่ผู้ใช้ยืนยัน - สถานะรถเปลี่ยนไปแล้วตอบ 409 (vehicleIds อย่างเดียว = แบบเดิม)
  // 1 ครั้ง = ลูกค้ารายเดียว รถประเภทเดียว - รวมรถยนต์กับจักรยานยนต์ตอบ 400 (ผู้ใช้ 2026-09-27)
  @Post()
  submit(@Body() body: { items?: unknown; vehicleIds?: unknown; date?: unknown; recipient?: unknown; note?: unknown }) {
    return this.deliveryService.submit(body);
  }
}
