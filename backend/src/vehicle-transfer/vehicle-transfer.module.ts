import { Module } from '@nestjs/common';
import { receiptExtractorProvider } from '../receipts/receipt-extractor.js';
import { receiptStorageProvider } from '../receipts/receipt-storage.js';
import { VehicleTransferController } from './vehicle-transfer.controller.js';
import { VehicleTransferService } from './vehicle-transfer.service.js';

@Module({
  controllers: [VehicleTransferController],
  providers: [VehicleTransferService, receiptStorageProvider, receiptExtractorProvider],
})
export class VehicleTransferModule {}
