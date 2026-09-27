import { Module } from '@nestjs/common';
import { TaxModule } from '../tax/tax.module.js';
import { VehiclesController } from './vehicles.controller.js';
import { VehiclesService } from './vehicles.service.js';

// TaxModule: preview ภาษีตามข้อมูลใหม่ในคำเตือนตอนแก้ข้อมูลรถที่ยื่นแล้ว (ผู้ใช้ 2026-09-27)
@Module({
  imports: [TaxModule],
  controllers: [VehiclesController],
  providers: [VehiclesService],
})
export class VehiclesModule {}
