import { Module } from '@nestjs/common';
import { CustomerLineController } from './customer-line.controller.js';
import { CustomerLineService } from './customer-line.service.js';

@Module({
  controllers: [CustomerLineController],
  providers: [CustomerLineService],
})
export class CustomerLineModule {}
