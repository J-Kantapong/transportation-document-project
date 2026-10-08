import { Module } from '@nestjs/common';
import { SupplierRatesController } from './supplier-rates.controller.js';
import { SupplierRatesService } from './supplier-rates.service.js';

@Module({
  controllers: [SupplierRatesController],
  providers: [SupplierRatesService],
})
export class SupplierRatesModule {}
