import { Module } from '@nestjs/common';
import { receiptExtractorProvider } from '../receipts/receipt-extractor.js';
import { receiptStorageProvider } from '../receipts/receipt-storage.js';
import { PlateCopyController } from './plate-copy.controller.js';
import { PlateCopyService } from './plate-copy.service.js';

@Module({
  controllers: [PlateCopyController],
  providers: [PlateCopyService, receiptStorageProvider, receiptExtractorProvider],
})
export class PlateCopyModule {}
