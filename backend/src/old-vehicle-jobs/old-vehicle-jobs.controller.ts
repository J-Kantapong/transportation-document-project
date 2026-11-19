import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  type ChooseTypeDto,
  type IntakeDto,
  OldVehicleJobsService,
  type UpdateOldVehicleDto,
} from './old-vehicle-jobs.service.js';

// หน้ารวม "งานรถเก่า" (ผู้ใช้ 2026-11-18) - สิทธิ์กลุ่มยื่นเอกสาร ดู access-policy.ts / ไม่มีการลบ ใช้ POST jobs/:id/cancel
@Controller('api/old-vehicle-jobs')
export class OldVehicleJobsController {
  constructor(private readonly service: OldVehicleJobsService) {}

  // GET /api/old-vehicle-jobs?scope=open|done|all&q=&vehicleClass=CAR|MOTO
  @Get()
  list(@Query('scope') scope = 'open', @Query('q') q?: string, @Query('vehicleClass') vehicleClass?: string) {
    return this.service.list(scope, q, vehicleClass);
  }

  // GET /api/old-vehicle-jobs/lookup?chassis=&plateCategory=&plateNumber= - รถที่มีอยู่แล้ว + คำเตือนเลขตัวถัง
  @Get('lookup')
  lookup(@Query('chassis') chassis?: string, @Query('plateCategory') plateCategory?: string, @Query('plateNumber') plateNumber?: string) {
    return this.service.lookup(chassis, plateCategory, plateNumber);
  }

  // GET /api/old-vehicle-jobs/suggest?q= - คำแนะนำระหว่างพิมพ์ (รถเก่า + รถจดใหม่ที่ยังไม่เคยรับงาน)
  @Get('suggest')
  suggest(@Query('q') q?: string) {
    return this.service.suggest(q);
  }

  // GET /api/old-vehicle-jobs/finance-companies - รายชื่อไฟแนนซ์ให้ฟอร์มรับงาน
  @Get('finance-companies')
  financeCompanies() {
    return this.service.financeCompanyNames();
  }

  // รับงาน { customerId, receivedDate, vehicles: [...] }
  // แถวรับงาน 1 งาน + ข้อมูลรถ (+ รถคู่ของสลับเลข รถเก่า กับ รถเก่า) - ฟอร์มยื่นของหน้างานเดิมใช้เติมข้อมูลให้เอง
  @Get('jobs/:id')
  getJob(@Param('id') id: string) {
    return this.service.getJob(id);
  }

  @Post('intake')
  intake(@Body() body: IntakeDto) {
    return this.service.intake(body ?? {});
  }

  // แก้ข้อมูลรถ { ..., remark, expectedUpdatedAt }
  @Patch('vehicles/:id')
  updateVehicle(@Param('id') id: string, @Body() body: UpdateOldVehicleDto) {
    return this.service.updateVehicle(id, body ?? {});
  }

  // เลือก/เปลี่ยนประเภทงาน { jobType, firstRegistrationDate?, taxExpiryDate?, duplicateReason? }
  @Patch('jobs/:id/type')
  chooseType(@Param('id') id: string, @Body() body: ChooseTypeDto) {
    return this.service.chooseType(id, body ?? {});
  }

  // บันทึกส่งตรวจหลายคัน { sentDate, sentType: OUTSIDE|BRING_IN, items: [{ id, cost }] }
  @Post('inspection-sent')
  sendInspection(@Body() body: { sentDate?: unknown; sentType?: unknown; items?: unknown }) {
    return this.service.sendInspection(body ?? {});
  }

  // บันทึกผลตรวจ { result: PASS|FAIL, resultDate }
  @Patch('jobs/:id/inspection-result')
  recordInspectionResult(@Param('id') id: string, @Body() body: { result?: unknown; resultDate?: unknown }) {
    return this.service.recordInspectionResult(id, body ?? {});
  }

  // ยกเลิกขั้นตรวจที่บันทึกผิด { remark }
  @Post('jobs/:id/inspection-undo')
  undoInspection(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return this.service.undoInspection(id, body?.remark);
  }

  // ติดธงติดขัด { reason, note? } / ปลด
  @Post('jobs/:id/block')
  block(@Param('id') id: string, @Body() body: { reason?: unknown; note?: unknown }) {
    return this.service.block(id, body ?? {});
  }

  @Post('jobs/:id/unblock')
  unblock(@Param('id') id: string) {
    return this.service.unblock(id);
  }

  // ยกเลิกการรับงานที่ยังไม่ยื่น { remark }
  @Post('jobs/:id/cancel')
  cancel(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return this.service.cancel(id, body?.remark);
  }
}
