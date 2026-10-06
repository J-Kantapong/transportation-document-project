import { Module } from '@nestjs/common';
import { EmployeesService } from './employees.service.js';
import { HrController } from './hr.controller.js';
import { PayrollService } from './payroll.service.js';
import { PrintSignatureController } from './print-signature.controller.js';
import { PayslipSignatureService } from './payslip-signature.service.js';
import { SupplierService } from './supplier.service.js';
import { WhtIssueService } from './wht-issue.service.js';

@Module({
  controllers: [HrController, PrintSignatureController],
  providers: [EmployeesService, PayrollService, PayslipSignatureService, WhtIssueService, SupplierService],
})
export class HrModule {}
