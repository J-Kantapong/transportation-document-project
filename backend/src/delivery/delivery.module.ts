import { Module } from '@nestjs/common';
import { DeliveryController } from './delivery.controller.js';
import { DeliverySheetService } from './delivery-sheet.service.js';
import { DeliveryService } from './delivery.service.js';

@Module({
  controllers: [DeliveryController],
  providers: [DeliveryService, DeliverySheetService],
})
export class DeliveryModule {}
