import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { BulkCreateDocumentSubmissionDto } from './dto/bulk-create-document-submission.dto.js';
import type { PreviewBulkDocumentSubmissionDto } from './dto/preview-bulk-document-submission.dto.js';
import { DocumentSubmissionService } from './document-submission.service.js';

@Controller('api/vehicles')
export class DocumentSubmissionController {
  constructor(private readonly documentSubmissionService: DocumentSubmissionService) {}

  // POST :id/document-submission และ :id/document-submission/preview (ยื่น/คำนวณทีละคัน) ถอดออกแล้ว (พบ 2026-09-27)
  // - หน้าเว็บใช้ preview-bulk / bulk เท่านั้น

  @Post('document-submission/preview-bulk')
  previewBulk(@Body() body: PreviewBulkDocumentSubmissionDto) {
    return this.documentSubmissionService.previewBulk(body);
  }

  @Post('document-submission/bulk')
  submitBulk(@Body() body: BulkCreateDocumentSubmissionDto) {
    return this.documentSubmissionService.submitBulk(body);
  }

  // หน้าดูข้อมูลที่ยื่นแล้ว: วันที่ยื่นทั้งหมดพร้อมจำนวน { dates: [{ date, count }] } แล้วโหลดรายการทีละวัน - ดู listDates
  @Get('document-submission/dates')
  listDates() {
    return this.documentSubmissionService.listDates();
  }

  // kind (car | moto) / q / offset ใช้กับตาราง "ได้ใบเสร็จแล้ว" (ค้นหา + โหลดเพิ่ม) - ดู DocumentSubmissionService.listByDate
  @Get('document-submission')
  list(
    @Query('date') date?: string,
    @Query('status') status?: string,
    @Query('kind') kind?: string,
    @Query('q') q?: string,
    @Query('offset') offset?: string,
  ) {
    return this.documentSubmissionService.listByDate(date, status, { kind, q, offset });
  }

  // หน้ารับใบเสร็จ: บันทึกผลตรวจทั้งใบยื่น - ดู DocumentSubmissionService.saveReceiptCheck
  @Post('document-submission/receipt-check')
  saveReceiptCheck(@Body() body: { receivedDate?: unknown; entries?: unknown }) {
    return this.documentSubmissionService.saveReceiptCheck(body);
  }

  // แก้วันที่ในใบเสร็จของรายการที่ได้ใบเสร็จแล้ว (ปุ่มแก้ในตาราง "ได้ใบเสร็จแล้ว") - แก้ได้เฉพาะช่องนี้ ต้องมี remark
  @Patch('document-submission/:id/receipt-date')
  updateReceiptDate(@Param('id') id: string, @Body() body: { receiptDate?: unknown; remark?: unknown }) {
    return this.documentSubmissionService.updateReceiptDate(id, body?.receiptDate, body?.remark);
  }

  // แก้ข้อมูลใบเสร็จของรายการที่ได้ใบเสร็จแล้ว (ทะเบียน/เลขที่/ยอด/วันที่รับ/วันที่ในใบเสร็จ) ต้องมี remark ไม่เปลี่ยนสถานะ
  // - ดู DocumentSubmissionService.updateReceiptFields
  @Patch('document-submission/:id/receipt-fields')
  updateReceiptFields(
    @Param('id') id: string,
    @Body()
    body: {
      plateCategory?: unknown;
      plateNumber?: unknown;
      receiptNo?: unknown;
      receiptAmount?: unknown;
      receiptDate?: unknown;
      receiptReceivedDate?: unknown;
      remark?: unknown;
    },
  ) {
    return this.documentSubmissionService.updateReceiptFields(id, body);
  }

  // แก้ค่าจ้างซับของรายการที่ส่งซับจดต่างจังหวัด (ผู้ใช้ 2026-10-08) ต้องมี remark - ดู DocumentSubmissionService.updateSupplierFee
  @Patch('document-submission/:id/supplier-fee')
  updateSupplierFee(
    @Param('id') id: string,
    @Body() body: { serviceFee?: unknown; channelFee?: unknown; inspectionFee?: unknown; remark?: unknown },
  ) {
    return this.documentSubmissionService.updateSupplierFee(id, body);
  }

  // ยกเลิกรายการที่ยังรอใบเสร็จ ให้รถกลับไปยื่นใหม่ได้ ต้องมี remark - ดู DocumentSubmissionService.cancel
  @Post('document-submission/:id/cancel')
  cancel(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return this.documentSubmissionService.cancel(id, body?.remark);
  }

  // PATCH document-submission/:id/status ถอดออกแล้ว (พบ 2026-09-27) - หน้าเว็บบันทึกผลผ่าน receipt-check เท่านั้น
  // (route เดิมบันทึกได้ใบเสร็จโดยไม่มีรูปใบเสร็จได้)
}
