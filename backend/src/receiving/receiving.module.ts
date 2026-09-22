import { Module } from '@nestjs/common';
import { ReceivingController } from './receiving.controller.js';
import { ReceivingService } from './receiving.service.js';
import { VehiclePhotosController } from './vehicle-photos.controller.js';
import { VehiclePhotosService } from './vehicle-photos.service.js';

@Module({
  controllers: [ReceivingController, VehiclePhotosController],
  providers: [ReceivingService, VehiclePhotosService],
})
export class ReceivingModule {}
