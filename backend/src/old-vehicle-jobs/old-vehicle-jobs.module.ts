import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { OldVehicleJobLinkInterceptor } from './old-vehicle-job-link.interceptor.js';
import { OldVehicleJobsController } from './old-vehicle-jobs.controller.js';
import { OldVehicleJobsService } from './old-vehicle-jobs.service.js';

@Module({
  controllers: [OldVehicleJobsController],
  // interceptor ทั้งแอป: หลังยื่นงานรถเก่าจากหน้าเดิม ผูกงานกับแถวรับงานทันที (ดู old-vehicle-job-link.interceptor.ts)
  providers: [OldVehicleJobsService, { provide: APP_INTERCEPTOR, useClass: OldVehicleJobLinkInterceptor }],
  exports: [OldVehicleJobsService],
})
export class OldVehicleJobsModule {}
