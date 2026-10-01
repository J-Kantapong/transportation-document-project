import { Module } from '@nestjs/common';
import { receiptStorageProvider } from '../receipts/receipt-storage.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { QuotationController } from './quotation.controller.js';
import { QuotationService } from './quotation.service.js';
import { TaxInvoiceController } from './tax-invoice.controller.js';
import { TaxInvoiceService } from './tax-invoice.service.js';

@Module({
  controllers: [BillingController, TaxInvoiceController, QuotationController],
  providers: [BillingService, TaxInvoiceService, QuotationService, receiptStorageProvider],
})
export class BillingModule {}
