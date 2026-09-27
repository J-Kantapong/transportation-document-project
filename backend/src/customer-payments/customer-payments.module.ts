import { Module } from '@nestjs/common';
import { CustomerPaymentsController } from './customer-payments.controller.js';
import { CustomerPaymentsService } from './customer-payments.service.js';

@Module({
  controllers: [CustomerPaymentsController],
  providers: [CustomerPaymentsService],
})
export class CustomerPaymentsModule {}
