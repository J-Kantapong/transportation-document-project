import { Module } from '@nestjs/common';
import { receiptExtractorProvider } from '../receipts/receipt-extractor.js';
import { receiptStorageProvider } from '../receipts/receipt-storage.js';
import { PlateSwapController } from './plate-swap.controller.js';
import { PlateSwapService } from './plate-swap.service.js';

@Module({
  controllers: [PlateSwapController],
  providers: [PlateSwapService, receiptStorageProvider, receiptExtractorProvider],
})
export class PlateSwapModule {}
