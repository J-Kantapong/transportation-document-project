import { Module } from '@nestjs/common';
import { receiptExtractorProvider } from '../receipts/receipt-extractor.js';
import { receiptStorageProvider } from '../receipts/receipt-storage.js';
import { TransferContributionRatesController } from './transfer-contribution-rates.controller.js';
import { TransferContributionRatesService } from './transfer-contribution-rates.service.js';
import { VehicleTransferController } from './vehicle-transfer.controller.js';
import { VehicleTransferService } from './vehicle-transfer.service.js';

@Module({
  controllers: [VehicleTransferController, TransferContributionRatesController],
  providers: [VehicleTransferService, TransferContributionRatesService, receiptStorageProvider, receiptExtractorProvider],
})
export class VehicleTransferModule {}
