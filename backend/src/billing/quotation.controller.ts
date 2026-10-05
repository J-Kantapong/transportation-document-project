import { Body, Controller, Delete, Get, Param, Patch, Post, Query, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_RECEIPT_BYTES, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { QuotationService, type QuotationDto } from './quotation.service.js';

// ใบเสนอราคา (ผู้ใช้ 2026-10-01) - สิทธิ์ ADMIN + ACCOUNTANT ตามกฎ /api/billing ใน access-policy.ts
@Controller('api/billing/quotations')
export class QuotationController {
  constructor(private readonly quotations: QuotationService) {}

  // ?stage=DRAFT|WAITING|EXPIRED|APPROVED|DONE|REJECTED|CANCELLED|SUPERSEDED&q=&offset= -> { quotations, hasMore, counts }
  @Get()
  list(@Query('stage') stage?: string, @Query('q') q?: string, @Query('offset') offset?: string) {
    return this.quotations.list({ stage, q, offset });
  }

  // ยอดแจ้งย้ายยามาฮ่าของเดือน + บรรทัดที่เสนอของขนาดนั้น ?month=YYYY-MM&size=SMALL|LARGE (รถเล็ก/รถใหญ่ ออกคนละใบ)
  @Get('yamaha-month')
  yamahaMonth(@Query('month') month?: string, @Query('size') size?: string) {
    return this.quotations.yamahaMonth(month, size);
  }

  // ใบที่อนุมัติแล้วและยังไม่ออกบิลของลูกค้า ?customerId=
  @Get('ready')
  async ready(@Query('customerId') customerId?: string) {
    return { quotations: customerId ? await this.quotations.readyToInvoice(customerId) : [] };
  }

  @Post()
  async create(@Body() body: QuotationDto) {
    return { quotation: await this.quotations.create(body ?? {}) };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return { quotation: await this.quotations.get(id) };
  }

  @Get(':id/history')
  async history(@Param('id') id: string) {
    return { entries: await this.quotations.history(id) };
  }

  // แก้ร่าง (ยังไม่ออกเลข)
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: QuotationDto) {
    return { quotation: await this.quotations.update(id, body ?? {}) };
  }

  // ลบร่าง
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.quotations.remove(id);
  }

  @Post(':id/issue')
  async issue(@Param('id') id: string, @Body() body: { expectedUpdatedAt?: unknown }) {
    return { quotation: await this.quotations.issue(id, body ?? {}) };
  }

  // multipart: approvedDate, poNumber, file (PDF / รูป), expectedUpdatedAt
  @Post(':id/approve')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 } }))
  async approve(@Param('id') id: string, @Body() body: Record<string, unknown>, @UploadedFile() file: UploadedReceiptFile | undefined) {
    return { quotation: await this.quotations.approve(id, body ?? {}, file) };
  }

  @Post(':id/unapprove')
  async unapprove(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return { quotation: await this.quotations.unapprove(id, body ?? {}) };
  }

  @Post(':id/reject')
  async reject(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return { quotation: await this.quotations.reject(id, body ?? {}) };
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return { quotation: await this.quotations.cancel(id, body ?? {}) };
  }

  // ทำฉบับแก้ไข -> ร่างใหม่ที่ผูกกับใบเดิม
  @Post(':id/revise')
  async revise(@Param('id') id: string) {
    return { quotation: await this.quotations.revise(id) };
  }

  @Post(':id/link-customer')
  async linkCustomer(@Param('id') id: string, @Body() body: { customerId?: unknown }) {
    return { quotation: await this.quotations.linkCustomer(id, body ?? {}) };
  }

  // ออกใบวางบิลจากใบเสนอราคา { invoiceNo, issueDate, whtRate? } -> { invoice, quotation }
  @Post(':id/invoice')
  createInvoice(@Param('id') id: string, @Body() body: { invoiceNo?: unknown; issueDate?: unknown; whtRate?: unknown }) {
    return this.quotations.createInvoice(id, body ?? {});
  }

  // ตั้งเป็นราคาลูกค้า (ใบเสนอราคาแบบราคาต่อคัน)
  @Post(':id/apply-rates')
  async applyRates(@Param('id') id: string) {
    return { quotation: await this.quotations.applyRates(id) };
  }

  @Get(':id/po-file')
  async poFile(@Param('id') id: string) {
    const { data, mimeType, fileName } = await this.quotations.poFile(id);
    return new StreamableFile(data, { type: mimeType, disposition: `inline; filename="${encodeURIComponent(fileName)}"` });
  }
}
