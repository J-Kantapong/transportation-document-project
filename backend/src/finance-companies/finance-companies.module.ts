import { Module } from '@nestjs/common';
import { FinanceCompaniesController } from './finance-companies.controller.js';
import { FinanceCompaniesService } from './finance-companies.service.js';

@Module({
  controllers: [FinanceCompaniesController],
  providers: [FinanceCompaniesService],
})
export class FinanceCompaniesModule {}
