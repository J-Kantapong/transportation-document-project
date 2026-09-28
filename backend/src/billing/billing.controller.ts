import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { BillingService, type CreateInvoiceDto, type UpdateInvoiceDto } from './billing.service.js';

// สิทธิ์: ทั้ง /api/billing = ADMIN + ACCOUNTANT ยกเว้นเปิดงานกลับ (vehicles/:id/reopen) = ADMIN เท่านั้น - ดู access-policy.ts
@Controller('api/billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get('queue')
  queue() {
    return this.billingService.queue();
  }

  @Get('customers/:id/terms')
  async getTerms(@Param('id') id: string) {
    return { terms: await this.billingService.getTerms(id) };
  }

  @Patch('customers/:id/terms')
  // remark บังคับ (ผู้ใช้ 2026-09-27) - เก็บค่าก่อน/หลังลง AuditLog ของลูกค้า
  async updateTerms(@Param('id') id: string, @Body() body: { vat?: unknown; whtRate?: unknown; whtSpecialRate?: unknown; whtSpecialUntil?: unknown; remark?: unknown }) {
    return { terms: await this.billingService.updateTerms(id, body) };
  }

  // บัญชีรับเงิน (บริษัท/บุคคล) พร้อมวันเริ่มใช้ - remark บังคับ (ผู้ใช้ 2026-09-27)
  @Get('customers/:id/account')
  accountPeriods(@Param('id') id: string) {
    return this.billingService.accountPeriods(id);
  }

  @Post('customers/:id/account')
  setAccount(@Param('id') id: string, @Body() body: { account?: unknown; effectiveFrom?: unknown; remark?: unknown }) {
    return this.billingService.setAccount(id, body ?? {});
  }

  // ตั้งราคาล่วงหน้าให้ลูกค้าที่ยังไม่มีรถในคิววางบิล (ผู้ใช้ 2026-09-28)
  @Get('customers/:id/rates')
  async getRates(@Param('id') id: string) {
    return { rates: await this.billingService.getRates(id) };
  }

  @Put('customers/:id/rates')
  async replaceRates(@Param('id') id: string, @Body() body: { rates?: unknown }) {
    return { rates: await this.billingService.replaceRates(id, body) };
  }

  // { invoices, hasMore, outstanding } - บิลรอรับเงินครบทุกใบ + ประวัติทีละหน้า (offset / limit ของประวัติ)
  @Get('invoices')
  listInvoices(@Query('offset') offset?: string, @Query('limit') limit?: string) {
    return this.billingService.listInvoices({ offset, limit });
  }

  @Post('invoices')
  async createInvoice(@Body() body: CreateInvoiceDto) {
    return { invoice: await this.billingService.createInvoice(body) };
  }

  // แก้บิลที่ยังไม่รับเงิน เลขที่เดิม (ผู้ใช้ 2026-09-27) - ต้องมี remark
  @Patch('invoices/:id')
  async updateInvoice(@Param('id') id: string, @Body() body: UpdateInvoiceDto) {
    return { invoice: await this.billingService.updateInvoice(id, body ?? {}) };
  }

  @Get('invoices/:id/history')
  async invoiceHistory(@Param('id') id: string) {
    return { entries: await this.billingService.invoiceHistory(id) };
  }

  // ข้อมูลรถปัจจุบันของแต่ละคันในบิล - หน้าแก้บิลเทียบกับข้อมูลในบิล (ทะเบียน / เลขที่ใบเสร็จที่แก้หลังออกบิล)
  @Get('invoices/:id/live-lines')
  async invoiceLiveLines(@Param('id') id: string) {
    return { lines: await this.billingService.invoiceLiveLines(id) };
  }

  @Patch('invoices/:id/paid')
  async markPaid(@Param('id') id: string, @Body() body: { paidDate?: unknown; taxInvoiceNo?: unknown }) {
    return { invoice: await this.billingService.markPaid(id, body) };
  }

  // ยกเลิกการรับเงิน PAID -> ISSUED พร้อมเหตุผล (ผู้ใช้ 2026-09-27)
  @Patch('invoices/:id/unpay')
  async unpayInvoice(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return { invoice: await this.billingService.unpayInvoice(id, body) };
  }

  @Patch('invoices/:id/void')
  async voidInvoice(@Param('id') id: string, @Body() body: { reason?: unknown }) {
    return { invoice: await this.billingService.voidInvoice(id, body) };
  }

  // ปิดงาน - วางบิลนอกระบบ (ผู้ใช้ 2026-09-27): { vehicles, hasMore } ใหม่สุดทีละ 100 คัน
  @Get('vehicles/closed')
  listClosedVehicles(@Query('offset') offset?: string) {
    return this.billingService.listClosedVehicles({ offset });
  }

  @Post('vehicles/:id/close')
  async closeVehicleBilling(@Param('id') id: string, @Body() body: { note?: unknown }) {
    return { vehicle: await this.billingService.closeVehicleBilling(id, body) };
  }

  @Post('vehicles/:id/reopen')
  reopenVehicleBilling(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return this.billingService.reopenVehicleBilling(id, body);
  }
}
