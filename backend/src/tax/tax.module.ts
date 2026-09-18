import { Module } from '@nestjs/common';
import { TaxController } from './tax.controller.js';
import { TaxService } from './tax.service.js';

@Module({
  controllers: [TaxController],
  providers: [TaxService],
  exports: [TaxService],
})
export class TaxModule {}
