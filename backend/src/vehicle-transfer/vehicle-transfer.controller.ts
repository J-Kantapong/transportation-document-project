import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_RECEIPT_BYTES, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { type CreateVehicleTransferDto, type UpdateVehicleTransferDto, VehicleTransferService } from './vehicle-transfer.service.js';

// งานโอน (งานหลัก, ผู้ใช้ 2026-10-02) - สิทธิ์กลุ่มยื่นเอกสาร ดู access-policy.ts / ไม่มีการลบงาน ใช้ POST /:id/cancel แทน
@Controller('api/vehicle-transfers')
export class VehicleTransferController {
  constructor(private readonly service: VehicleTransferService) {}

  // GET /api/vehicle-transfers?status=all|pending|returned|to-send|to-result|inspected&month=YYYY-MM&transferType=OWNER|INSPECTION&vehicleClass=CAR|MOTO
  @Get()
  list(
    @Query('status') status = 'all',
    @Query('month') month?: string,
    @Query('transferType') transferType?: string,
    @Query('vehicleClass') vehicleClass?: string,
  ) {
    return this.service.list(status, month || undefined, transferType, vehicleClass);
  }

  @Post()
  create(@Body() body: CreateVehicleTransferDto) {
    return this.service.create(body);
  }

  // แก้เจ้าของงาน / ผู้โอน / ผู้รับโอน / ข้อมูลรถ / วันที่ยื่น / วันที่รับกลับ - remark บังคับ
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateVehicleTransferDto) {
    return this.service.update(id, body ?? {});
  }

  // โอนตรวจรถ: บันทึกวันที่ส่งตรวจ { sentDate }
  @Patch(':id/inspection-sent')
  markInspectionSent(@Param('id') id: string, @Body() body: { sentDate?: unknown }) {
    return this.service.markInspectionSent(id, body?.sentDate);
  }

  // โอนตรวจรถ: บันทึกผลตรวจ { result: PASS|FAIL, resultDate }
  @Patch(':id/inspection-result')
  recordInspectionResult(@Param('id') id: string, @Body() body: { result?: unknown; resultDate?: unknown }) {
    return this.service.recordInspectionResult(id, body?.result, body?.resultDate);
  }

  // ถอยหนึ่งขั้นของขั้นตรวจรถ { remark } - ล้างผลตรวจ หรือถ้ายังไม่มีผลก็ล้างวันที่ส่งตรวจ
  @Post(':id/inspection-undo')
  undoInspection(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return this.service.undoInspection(id, body?.remark);
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

  // ยกเลิกงาน { remark } - แถวยังอยู่ (cancelledAt) แต่ไม่แสดงในรายการ
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
}
