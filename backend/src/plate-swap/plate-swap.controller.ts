import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_RECEIPT_BYTES, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { type CreatePlateSwapDto, PlateSwapService, type UpdatePlateSwapDto } from './plate-swap.service.js';

// การสลับเลข รถเก่า <-> รถใหม่ (รถยนต์) - สิทธิ์กลุ่มยื่นเอกสาร (STAFF_CAR) ดู access-policy.ts
// ผู้ใช้ 2026-09-27: ไม่มีการลบงานแล้ว (DELETE /:id ถูกถอด) ใช้ POST /:id/cancel { remark } ยกเลิกแบบเก็บแถวไว้แทน
@Controller('api/plate-swaps')
export class PlateSwapController {
  constructor(private readonly service: PlateSwapService) {}

  // GET /api/plate-swaps?status=pending|returned|all&month=YYYY-MM
  @Get()
  list(@Query('status') status = 'all', @Query('month') month?: string) {
    return this.service.list(status, month || undefined);
  }

  // ค้นรถใหม่ในฐานข้อมูลรถจดใหม่เพื่อลิงก์ - excludeSwapId = งานที่กำลังเปลี่ยนคัน (ไม่นับว่าผูกซ้ำกับตัวเอง)
  @Get('vehicle-search')
  async vehicleSearch(@Query('chassis') chassis = '', @Query('excludeSwapId') excludeSwapId?: string) {
    return { vehicles: await this.service.searchNewVehicles(chassis, excludeSwapId || undefined) };
  }

  @Post()
  create(@Body() body: CreatePlateSwapDto) {
    return this.service.create(body);
  }

  // แก้ข้อมูลรถเก่า / วันที่ยื่น / ที่มาของเลขและป้าย / วันที่รับกลับ - remark บังคับ (ผู้ใช้ 2026-09-27)
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdatePlateSwapDto) {
    return this.service.update(id, body ?? {});
  }

  // remark บังคับเฉพาะงานที่รับเอกสารกลับแล้ว
  @Patch(':id/new-vehicle')
  link(@Param('id') id: string, @Body() body: { newVehicleId?: unknown; remark?: unknown }) {
    return this.service.linkNewVehicle(id, body?.newVehicleId, body?.remark);
  }

  // กรอก/แก้ทะเบียนใหม่ทีหลัง (ตอนยื่นอาจยังไม่รู้เลข) - หมวดทะเบียน + เลขทะเบียน / remark บังคับหลังรับเอกสารกลับ
  @Patch(':id/new-plate')
  setNewPlate(@Param('id') id: string, @Body() body: { newPlateCategory?: unknown; newPlateNumber?: unknown; remark?: unknown }) {
    return this.service.setNewPlate(id, body?.newPlateCategory, body?.newPlateNumber, body?.remark);
  }

  @Patch(':id/return')
  markReturned(@Param('id') id: string, @Body() body: { returnedDate?: unknown; newPlateCategory?: unknown; newPlateNumber?: unknown }) {
    return this.service.markReturned(id, body?.returnedDate, body?.newPlateCategory, body?.newPlateNumber);
  }

  // ยกเลิกการรับเอกสารกลับที่กดผิด { remark }
  @Post(':id/undo-return')
  undoReturn(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return this.service.undoReturn(id, body?.remark);
  }

  // ยกเลิกงาน { remark } - แถวยังอยู่ (cancelledAt) แต่ไม่แสดงในรายการ ยอดรวม และภาพรวม
  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return this.service.cancel(id, body?.remark);
  }

  // multipart/form-data: file = รูปใบเสร็จ, remark = เหตุผล (บังคับเฉพาะงานที่รับเอกสารกลับแล้ว)
  @Post(':id/receipts')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 } }))
  addReceipt(@Param('id') id: string, @UploadedFile() file: UploadedReceiptFile | undefined, @Body() body: { remark?: unknown }) {
    return this.service.addReceipt(id, file, body?.remark);
  }

  // body { remark } บังคับเฉพาะงานที่รับเอกสารกลับแล้ว
  @Delete(':id/receipts/:receiptId')
  removeReceipt(@Param('id') id: string, @Param('receiptId') receiptId: string, @Body() body: { remark?: unknown }) {
    return this.service.removeReceipt(id, receiptId, body?.remark);
  }
}
