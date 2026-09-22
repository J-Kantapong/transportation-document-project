import { Module } from '@nestjs/common';
import { receiptStorageProvider } from '../receipts/receipt-storage.js';
import { PlateSwapController } from './plate-swap.controller.js';
import { PlateSwapService } from './plate-swap.service.js';

@Module({
  controllers: [PlateSwapController],
  providers: [PlateSwapService, receiptStorageProvider],
})
export class PlateSwapModule {}
