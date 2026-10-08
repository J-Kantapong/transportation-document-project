import { Module } from '@nestjs/common';
import { receiptExtractorProvider } from '../receipts/receipt-extractor.js';
import { receiptStorageProvider } from '../receipts/receipt-storage.js';
import { TaxModule } from '../tax/tax.module.js';
import { TaxRenewalController } from './tax-renewal.controller.js';
import { TaxRenewalService } from './tax-renewal.service.js';

@Module({
  imports: [TaxModule], // ใช้ TaxService.loadRuleSet() เพื่อใช้ตารางอัตราภาษีชุดเดียวกับขั้นตอนที่ 4
  controllers: [TaxRenewalController],
  providers: [TaxRenewalService, receiptStorageProvider, receiptExtractorProvider],
})
export class TaxRenewalModule {}
