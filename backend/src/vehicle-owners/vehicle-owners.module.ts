import { Module } from '@nestjs/common';
import { VehicleOwnersController } from './vehicle-owners.controller.js';
import { VehicleOwnersService } from './vehicle-owners.service.js';

@Module({
  controllers: [VehicleOwnersController],
  providers: [VehicleOwnersService],
  exports: [VehicleOwnersService],
})
export class VehicleOwnersModule {}
