import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { EmployeesService, type EmployeeInput } from './employees.service.js';
import { PayrollService } from './payroll.service.js';
import { PayslipSignatureService } from './payslip-signature.service.js';

// ฝ่ายบุคคล / เงินเดือน - ADMIN เท่านั้น (access-policy.ts: /api/hr) ข้อมูลส่วนบุคคลและเงินเดือนไม่เปิดให้บทบาทอื่น
@Controller('api/hr')
export class HrController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly payroll: PayrollService,
    private readonly signature: PayslipSignatureService,
  ) {}

  // ลายเซ็นผู้จ่ายเงินบนสลิป (ผู้ใช้ 2026-10-06)
  @Get('payslip-signature')
  getSignature() {
    return this.signature.get();
  }

  @Put('payslip-signature')
  setSignature(@Body() body: { imageDataUrl?: unknown; signerName?: unknown }) {
    return this.signature.set(body ?? {});
  }

  @Delete('payslip-signature')
  removeSignature() {
    return this.signature.remove();
  }

  @Get('employees')
  listEmployees(@Query('status') status?: string, @Query('q') q?: string) {
    return this.employees.list({ status, q });
  }

  @Post('employees')
  async createEmployee(@Body() body: EmployeeInput) {
    return { employee: await this.employees.create(body ?? {}) };
  }

  // ต้องมาก่อน employees/:id เพื่อไม่ให้ "import" ถูกตีเป็น id
  @Post('employees/import')
  importEmployees(@Body() body: { rows?: unknown }) {
    return this.employees.importMany(body ?? {});
  }

  @Patch('employees/:id')
  async updateEmployee(@Param('id') id: string, @Body() body: EmployeeInput & { remark?: unknown; expectedUpdatedAt?: unknown }) {
    return { employee: await this.employees.update(id, body ?? {}) };
  }

  @Post('employees/:id/resign')
  async resign(@Param('id') id: string, @Body() body: { date?: unknown; remark?: unknown }) {
    return { employee: await this.employees.resign(id, body ?? {}) };
  }

  @Post('employees/:id/reinstate')
  async reinstate(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return { employee: await this.employees.reinstate(id, body ?? {}) };
  }

  @Get('employees/:id/history')
  employeeHistory(@Param('id') id: string) {
    return this.employees.history(id);
  }

  @Get('payroll/runs')
  listRuns() {
    return this.payroll.listRuns();
  }

  @Patch('payroll/runs/:id/pay-date')
  async setPayDate(@Param('id') id: string, @Body() body: { payDate?: unknown; remark?: unknown }) {
    return { run: await this.payroll.setPayDate(id, body ?? {}) };
  }

  @Post('payroll/runs')
  async createRun(@Body() body: { month?: unknown; payDate?: unknown }) {
    return { run: await this.payroll.createRun(body ?? {}) };
  }

  @Get('payroll/runs/:id')
  async getRun(@Param('id') id: string) {
    return { run: await this.payroll.getRun(id) };
  }

  @Get('payroll/runs/:id/history')
  runHistory(@Param('id') id: string) {
    return this.payroll.history(id);
  }

  @Patch('payroll/runs/:id/items/:itemId')
  async updateItem(@Param('id') id: string, @Param('itemId') itemId: string, @Body() body: Record<string, unknown>) {
    return { run: await this.payroll.updateItem(id, itemId, body ?? {}) };
  }

  @Post('payroll/runs/:id/recalculate')
  async recalculate(@Param('id') id: string) {
    return { run: await this.payroll.recalculate(id) };
  }

  @Post('payroll/runs/:id/approve')
  async approve(@Param('id') id: string) {
    return { run: await this.payroll.approve(id) };
  }

  @Post('payroll/runs/:id/unapprove')
  async unapprove(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return { run: await this.payroll.unapprove(id, body ?? {}) };
  }

  @Post('payroll/runs/:id/pay')
  async pay(@Param('id') id: string, @Body() body: { payDate?: unknown }) {
    return { run: await this.payroll.pay(id, body ?? {}) };
  }

  @Post('payroll/runs/:id/unpay')
  async unpay(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return { run: await this.payroll.unpay(id, body ?? {}) };
  }

  @Post('payroll/runs/:id/cancel')
  async cancel(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return { run: await this.payroll.cancel(id, body ?? {}) };
  }
}
