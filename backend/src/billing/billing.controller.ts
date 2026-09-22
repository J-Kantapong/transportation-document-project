import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { BillingService, type CreateInvoiceDto } from './billing.service.js';

@Controller('api/billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get('queue')
  queue() {
    return this.billingService.queue();
  }

  @Patch('customers/:id/terms')
  async updateTerms(@Param('id') id: string, @Body() body: { vat?: unknown; whtRate?: unknown; whtSpecialRate?: unknown; whtSpecialUntil?: unknown }) {
    return { terms: await this.billingService.updateTerms(id, body) };
  }

  @Put('customers/:id/rates')
  async replaceRates(@Param('id') id: string, @Body() body: { rates?: unknown }) {
    return { rates: await this.billingService.replaceRates(id, body) };
  }

  @Get('invoices')
  async listInvoices() {
    return { invoices: await this.billingService.listInvoices() };
  }

  @Post('invoices')
  async createInvoice(@Body() body: CreateInvoiceDto) {
    return { invoice: await this.billingService.createInvoice(body) };
  }

  @Patch('invoices/:id/paid')
  async markPaid(@Param('id') id: string, @Body() body: { paidDate?: unknown; taxInvoiceNo?: unknown }) {
    return { invoice: await this.billingService.markPaid(id, body) };
  }

  @Patch('invoices/:id/void')
  async voidInvoice(@Param('id') id: string, @Body() body: { reason?: unknown }) {
    return { invoice: await this.billingService.voidInvoice(id, body) };
  }
}
