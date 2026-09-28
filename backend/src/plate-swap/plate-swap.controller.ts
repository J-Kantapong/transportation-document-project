import { Body, Controller, Delete, Get, Param, Patch, Post, Query, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_RECEIPT_BYTES, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { type CreatePlateSwapDto, type CreatePlateSwapPairDto, PlateSwapService, type UpdatePlateSwapDto } from './plate-swap.service.js';

// การสลับเลข รถเก่า <-> รถใหม่ (รถยนต์) - สิทธิ์กลุ่มยื่นเอกสาร (STAFF_CAR) ดู access-policy.ts
// ผู้ใช้ 2026-09-27: ไม่มีการลบงานแล้ว (DELETE /:id ถูกถอด) ใช้ POST /:id/cancel { remark } ยกเลิกแบบเก็บแถวไว้แทน
@Controller('api/plate-swaps')
export class PlateSwapController {
  constructor(private readonly service: PlateSwapService) {}

  // GET /api/plate-swaps?status=pending|returned|all&month=YYYY-MM
  @Get()
  // kind = OLD_NEW (ค่าเริ่มต้น) | OLD_OLD - งานคนละเคสไม่ปนกันในรายการ (ผู้ใช้ 2026-09-28)
  // vehicleClass = CAR (ค่าเริ่มต้น) | MOTO - งานรถยนต์กับมอเตอร์ไซค์แยกกันคนละรายการ (ผู้ใช้ 2026-09-28)
  list(@Query('status') status = 'all', @Query('month') month?: string, @Query('kind') kind?: string, @Query('vehicleClass') vehicleClass?: string) {
    return this.service.list(status, month || undefined, kind, vehicleClass);
  }

  // ค้นรถใหม่ในฐานข้อมูลรถจดใหม่เพื่อลิงก์ - excludeSwapId = งานที่กำลังเปลี่ยนคัน (ไม่นับว่าผูกซ้ำกับตัวเอง)
  @Get('vehicle-search')
  async vehicleSearch(@Query('chassis') chassis = '', @Query('excludeSwapId') excludeSwapId?: string, @Query('vehicleClass') vehicleClass?: string) {
    return { vehicles: await this.service.searchNewVehicles(chassis, excludeSwapId || undefined, vehicleClass === 'MOTO' ? 'MOTO' : 'CAR') };
  }

  // GET /api/plate-swaps/plate-queue?status=pending|received|all (หน้ารับป้าย - ผู้ใช้ 2026-09-28)
  @Get('plate-queue')
  plateQueue(@Query('status') status = 'all', @Query('kind') kind?: string, @Query('vehicleClass') vehicleClass?: string) {
    return this.service.listByPlateStatus(status, kind, vehicleClass);
  }

  // GET /api/plate-swaps/book-queue?status=pending|received|all (หน้ารับเล่ม - ผู้ใช้ 2026-09-28)
  @Get('book-queue')
  bookQueue(@Query('status') status = 'all', @Query('kind') kind?: string, @Query('vehicleClass') vehicleClass?: string) {
    return this.service.listByBookStatus(status, kind, vehicleClass);
  }

  @Post()
  create(@Body() body: CreatePlateSwapDto) {
    return this.service.create(body);
  }

  // ยื่นงาน 'รถเก่า กับ รถเก่า' - กรอก 2 คันในคำขอเดียว ระบบสร้าง 2 งานที่ผูกกันด้วย pairId (ผู้ใช้ 2026-09-28)
  @Post('pair')
  createPair(@Body() body: CreatePlateSwapPairDto) {
    return this.service.createPair(body);
  }

  // แก้เจ้าของงาน / ข้อมูลรถเก่า / วันที่ยื่น / ที่มาของเลขและป้าย / วันที่รับกลับ - remark บังคับ (ผู้ใช้ 2026-09-27)
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

  // แก้/กรอกเองเลขที่ใบเสร็จ/วันที่/ยอดเงิน { receiptNo?, receiptDate?, receiptAmount?, remark? } - remark บังคับหลังรับเอกสารกลับ
  @Patch(':id/receipt-fields')
  updateReceiptFields(
    @Param('id') id: string,
    @Body() body: { receiptNo?: unknown; receiptDate?: unknown; receiptAmount?: unknown; remark?: unknown },
  ) {
    return this.service.updateReceiptFields(id, body ?? {});
  }

  // --- รับป้าย/รับเล่ม (ไม่ใช้ AI - ผู้ใช้ 2026-09-28) --------------------------------------------------------------

  // multipart/form-data: file = รูปป้ายทะเบียน, date = YYYY-MM-DD -> บันทึกรับป้ายทันที
  @Post(':id/plate-photo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 } }))
  attachPlatePhoto(@Param('id') id: string, @UploadedFile() file: UploadedReceiptFile | undefined, @Body() body: { date?: unknown }) {
    return this.service.attachPlatePhoto(id, file, body?.date);
  }

  // แก้วันที่รับป้ายที่พิมพ์ผิด { date, remark }
  @Patch(':id/plate-photo/date')
  updatePlateReceivedDate(@Param('id') id: string, @Body() body: { date?: unknown; remark?: unknown }) {
    return this.service.updatePlateReceivedDate(id, body ?? {});
  }

  // ถอดรูปป้ายที่แนบผิด { remark }
  @Post(':id/plate-photo/detach')
  detachPlatePhoto(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return this.service.detachPlatePhoto(id, body ?? {});
  }

  @Get(':id/plate-photo/image')
  async platePhotoImage(@Param('id') id: string) {
    const { data, mimeType } = await this.service.getPlatePhotoImage(id);
    return new StreamableFile(data, { type: mimeType, disposition: 'inline' });
  }

  // multipart/form-data: file = รูปเล่มทะเบียน, date = YYYY-MM-DD -> บันทึกรับเล่มทันที
  @Post(':id/book-photo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 } }))
  attachBookPhoto(@Param('id') id: string, @UploadedFile() file: UploadedReceiptFile | undefined, @Body() body: { date?: unknown }) {
    return this.service.attachBookPhoto(id, file, body?.date);
  }

  // แก้วันที่รับเล่มที่พิมพ์ผิด { date, remark }
  @Patch(':id/book-photo/date')
  updateBookReceivedDate(@Param('id') id: string, @Body() body: { date?: unknown; remark?: unknown }) {
    return this.service.updateBookReceivedDate(id, body ?? {});
  }

  // ถอดรูปเล่มที่แนบผิด { remark }
  @Post(':id/book-photo/detach')
  detachBookPhoto(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return this.service.detachBookPhoto(id, body ?? {});
  }

  @Get(':id/book-photo/image')
  async bookPhotoImage(@Param('id') id: string) {
    const { data, mimeType } = await this.service.getBookPhotoImage(id);
    return new StreamableFile(data, { type: mimeType, disposition: 'inline' });
  }
}
