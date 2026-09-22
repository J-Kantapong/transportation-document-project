import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_RECEIPT_BYTES, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { type CreatePlateSwapDto, PlateSwapService } from './plate-swap.service.js';

// การสลับเลข รถเก่า <-> รถใหม่ (รถยนต์) - สิทธิ์กลุ่มยื่นเอกสาร (STAFF_CAR) ดู access-policy.ts
@Controller('api/plate-swaps')
export class PlateSwapController {
  constructor(private readonly service: PlateSwapService) {}

  // GET /api/plate-swaps?status=pending|returned|all&month=YYYY-MM
  @Get()
  list(@Query('status') status = 'all', @Query('month') month?: string) {
    return this.service.list(status, month || undefined);
  }

  // ค้นรถใหม่ในฐานข้อมูลรถจดใหม่เพื่อลิงก์
  @Get('vehicle-search')
  async vehicleSearch(@Query('chassis') chassis = '') {
    return { vehicles: await this.service.searchNewVehicles(chassis) };
  }

  @Post()
  create(@Body() body: CreatePlateSwapDto) {
    return this.service.create(body);
  }

  @Patch(':id/new-vehicle')
  link(@Param('id') id: string, @Body() body: { newVehicleId?: unknown }) {
    return this.service.linkNewVehicle(id, body?.newVehicleId);
  }

  @Patch(':id/return')
  markReturned(@Param('id') id: string, @Body() body: { returnedDate?: unknown }) {
    return this.service.markReturned(id, body?.returnedDate);
  }

  // multipart/form-data: file = รูปใบเสร็จ
  @Post(':id/receipts')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 } }))
  addReceipt(@Param('id') id: string, @UploadedFile() file: UploadedReceiptFile | undefined) {
    return this.service.addReceipt(id, file);
  }

  @Delete(':id/receipts/:receiptId')
  removeReceipt(@Param('id') id: string, @Param('receiptId') receiptId: string) {
    return this.service.removeReceipt(id, receiptId);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
