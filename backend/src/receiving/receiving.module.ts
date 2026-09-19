import { Module } from '@nestjs/common';
import { ReceivingController } from './receiving.controller.js';
import { ReceivingService } from './receiving.service.js';

@Module({
  controllers: [ReceivingController],
  providers: [ReceivingService],
})
export class ReceivingModule {}
