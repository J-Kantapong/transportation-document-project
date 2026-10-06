import { Body, Controller, Get, Param, Post, Query, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_RECEIPT_BYTES, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { TaxInvoiceService } from './tax-invoice.service.js';

// ใบกำกับภาษี/ใบเสร็จรับเงิน + 50 ทวิ (ผู้ใช้ 2026-09-28) - สิทธิ์ ADMIN + ACCOUNTANT ตามกฎ /api/billing
// ยกเว้นตั้งเลขเริ่ม (tax-invoices/series/set) = ADMIN เท่านั้น - ดู access-policy.ts
@Controller('api/billing')
export class TaxInvoiceController {
  constructor(private readonly taxInvoices: TaxInvoiceService) {}

  @Get('tax-invoices/series')
  series() {
    return this.taxInvoices.series();
  }

  @Post('tax-invoices/series/set')
  setSeries(@Body() body: { year?: unknown; lastNumber?: unknown; remark?: unknown }) {
    return this.taxInvoices.setSeries(body ?? {});
  }

  // ?month=YYYY-MM (ไม่ส่ง = เดือนนี้) - รวมใบที่ยกเลิก ใช้เป็นรายงานภาษีขาย
  @Get('tax-invoices')
  list(@Query('month') month?: string) {
    return this.taxInvoices.list({ month });
  }

  // ใบกำกับกำหนดเอง (งานนอกระบบ ไม่มีใบวางบิล, ผู้ใช้ 2026-10-05) - ต้องอยู่ก่อน tax-invoices/:id
  @Get('tax-invoices/custom-preview')
  customPreview(@Query('customerId') customerId?: string, @Query('date') date?: string) {
    return this.taxInvoices.customPreview(customerId ?? '', date);
  }

  // { customerId, issueDate (วันที่รับเงิน), items: [{ kind, description, quantity, unitPrice }], whtAmount, whtMethod, buyerNotVatRegistered?, replacesId? }
  @Post('tax-invoices/custom')
  async issueCustom(@Body() body: Record<string, unknown>) {
    return { taxInvoice: await this.taxInvoices.issueCustom(body ?? {}) };
  }

  @Get('tax-invoices/:id')
  async get(@Param('id') id: string) {
    return { taxInvoice: await this.taxInvoices.get(id) };
  }

  @Post('tax-invoices/:id/cancel')
  async cancel(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return { taxInvoice: await this.taxInvoices.cancel(id, body ?? {}) };
  }

  @Post('tax-invoices/:id/replacement')
  async replacement(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return { taxInvoice: await this.taxInvoices.replacement(id, body ?? {}) };
  }

  @Get('invoices/:id/tax-invoice-preview')
  issuePreview(@Param('id') id: string) {
    return this.taxInvoices.issuePreview(id);
  }

  // รับเงิน + ออกใบกำกับ { paidDate, whtAmount, whtMethod: NONE|PAPER|EWHT, buyerNotVatRegistered?, expectedUpdatedAt? }
  @Post('invoices/:id/tax-invoice')
  async issue(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return { taxInvoice: await this.taxInvoices.issue(id, body ?? {}) };
  }

  @Get('wht-pending')
  whtPending() {
    return this.taxInvoices.whtPending();
  }

  @Post('wht-pending/remind')
  remind(@Body() body: { taxInvoiceIds?: unknown }) {
    return this.taxInvoices.remind(body ?? {});
  }

  @Get('wht-certificates')
  listCertificates(@Query('customerId') customerId?: string) {
    return this.taxInvoices.listCertificates({ customerId });
  }

  // multipart: file (รูป/PDF - บังคับสำหรับกระดาษ), method, certificateNo, certificateDate, amount, note, taxInvoiceIds (คั่นด้วย ,)
  @Post('wht-certificates')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 } }))
  createCertificate(@Body() body: Record<string, unknown>, @UploadedFile() file: UploadedReceiptFile | undefined) {
    return this.taxInvoices.createCertificate(body ?? {}, file);
  }

  @Post('wht-certificates/:id/cancel')
  cancelCertificate(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return this.taxInvoices.cancelCertificate(id, body ?? {});
  }

  @Get('wht-certificates/:id/file')
  async certificateFile(@Param('id') id: string) {
    const { data, mimeType, fileName } = await this.taxInvoices.certificateFile(id);
    return new StreamableFile(data, { type: mimeType, disposition: `inline; filename="${encodeURIComponent(fileName)}"` });
  }
}
