import { Module } from '@nestjs/common';
import { receiptExtractorProvider } from '../receipts/receipt-extractor.js';
import { receiptStorageProvider } from '../receipts/receipt-storage.js';
import { VehicleUseCancellationController } from './vehicle-use-cancellation.controller.js';
import { VehicleUseCancellationService } from './vehicle-use-cancellation.service.js';

@Module({
  controllers: [VehicleUseCancellationController],
  providers: [VehicleUseCancellationService, receiptStorageProvider, receiptExtractorProvider],
})
export class VehicleUseCancellationModule {}
