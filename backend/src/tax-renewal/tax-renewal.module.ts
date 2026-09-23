import { Module } from '@nestjs/common';
import { TaxModule } from '../tax/tax.module.js';
import { TaxRenewalController } from './tax-renewal.controller.js';
import { TaxRenewalService } from './tax-renewal.service.js';

@Module({
  imports: [TaxModule], // ใช้ TaxService.loadRuleSet() เพื่อใช้ตารางอัตราภาษีชุดเดียวกับขั้นตอนที่ 4
  controllers: [TaxRenewalController],
  providers: [TaxRenewalService],
})
export class TaxRenewalModule {}
