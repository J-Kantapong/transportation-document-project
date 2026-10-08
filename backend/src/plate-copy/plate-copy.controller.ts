import { Body, Controller, Delete, Get, Param, Patch, Post, Query, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_RECEIPT_BYTES, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import {
  type CreatePlateCopyDto,
  type UpdatePlateCopyDto,
  PlateCopyService,
} from './plate-copy.service.js';

// คัดแผ่นป้ายทะเบียน (หมวด "อื่นๆ", ผู้ใช้ 2026-10-02) - สิทธิ์กลุ่มยื่นเอกสาร ดู access-policy.ts / ไม่มีการลบงาน ใช้ POST /:id/cancel แทน
@Controller('api/plate-copies')
export class PlateCopyController {
  constructor(private readonly service: PlateCopyService) {}

  // GET /api/plate-copies?status=pending|returned|all&month=YYYY-MM&vehicleClass=CAR|MOTO (ไม่ระบุประเภทรถ = ทุกประเภทที่ผู้ใช้อ่านได้)
  @Get()
  list(@Query('status') status = 'all', @Query('month') month?: string, @Query('vehicleClass') vehicleClass?: string) {
    return this.service.list(status, month || undefined, vehicleClass);
  }

  @Post()
  create(@Body() body: CreatePlateCopyDto) {
    return this.service.create(body);
  }

  // แก้เจ้าของงาน / ข้อมูลรถ / ชนิดการคัดป้าย (รถยนต์) / งานด่วน / วันที่ยื่น / วันที่รับกลับ - remark บังคับ (ประเภทรถเปลี่ยนไม่ได้)
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdatePlateCopyDto) {
    return this.service.update(id, body ?? {});
  }

  @Patch(':id/return')
  markReturned(@Param('id') id: string, @Body() body: { returnedDate?: unknown }) {
    return this.service.markReturned(id, body?.returnedDate);
  }

  // ยกเลิกการรับเอกสารกลับที่กดผิด { remark }
  @Post(':id/undo-return')
  undoReturn(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return this.service.undoReturn(id, body?.remark);
  }

  // ยกเลิกงาน { remark } - แถวยังอยู่ (cancelledAt) แต่ไม่แสดงในรายการและยอดรวม
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

  // --- รับป้าย (ผู้ใช้ 2026-10-02) - ไม่ใช้ AI ไม่ผูกกับ returnedDate ------------------------------------------------

  // GET /api/plate-copies/plate-queue?status=pending|received|all (หน้ารับป้าย)
  @Get('plate-queue')
  plateQueue(@Query('status') status = 'all', @Query('vehicleClass') vehicleClass?: string) {
    return this.service.listByPlateStatus(status, vehicleClass);
  }

  // multipart/form-data: file = รูปป้ายทะเบียนที่ได้รับ, date = YYYY-MM-DD -> บันทึกรับป้ายทันที
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
}
