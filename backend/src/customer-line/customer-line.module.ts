import { Module } from '@nestjs/common';
import { TaxModule } from '../tax/tax.module.js';
import { CustomerLineController } from './customer-line.controller.js';
import { CustomerLineService } from './customer-line.service.js';

@Module({
  imports: [TaxModule],
  controllers: [CustomerLineController],
  providers: [CustomerLineService],
})
export class CustomerLineModule {}
