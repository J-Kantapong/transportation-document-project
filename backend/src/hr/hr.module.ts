import { Module } from '@nestjs/common';
import { EmployeesService } from './employees.service.js';
import { HrController } from './hr.controller.js';
import { PayrollService } from './payroll.service.js';

@Module({
  controllers: [HrController],
  providers: [EmployeesService, PayrollService],
})
export class HrModule {}
