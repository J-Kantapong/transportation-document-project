import { Module } from '@nestjs/common';
import { receiptExtractorProvider } from '../receipts/receipt-extractor.js';
import { receiptStorageProvider } from '../receipts/receipt-storage.js';
import { VehicleMoveOutController } from './vehicle-move-out.controller.js';
import { VehicleMoveOutService } from './vehicle-move-out.service.js';

@Module({
  controllers: [VehicleMoveOutController],
  providers: [VehicleMoveOutService, receiptStorageProvider, receiptExtractorProvider],
})
export class VehicleMoveOutModule {}
