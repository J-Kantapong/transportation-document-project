import { Module } from '@nestjs/common';
import { EmployeesService } from './employees.service.js';
import { HrController } from './hr.controller.js';
import { PayrollService } from './payroll.service.js';
import { PrintSignatureController } from './print-signature.controller.js';
import { PayslipSignatureService } from './payslip-signature.service.js';

@Module({
  controllers: [HrController, PrintSignatureController],
  providers: [EmployeesService, PayrollService, PayslipSignatureService],
})
export class HrModule {}
