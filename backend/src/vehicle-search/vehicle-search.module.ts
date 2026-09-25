import { Module } from '@nestjs/common';
import { VehicleSearchController } from './vehicle-search.controller.js';
import { VehicleSearchService } from './vehicle-search.service.js';

@Module({
  controllers: [VehicleSearchController],
  providers: [VehicleSearchService],
})
export class VehicleSearchModule {}
