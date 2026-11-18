import { ReceiptRecheckController } from './receipt-recheck.controller.js';
import { Module } from '@nestjs/common';
import { receiptExtractorProvider } from './receipt-extractor.js';
import { receiptStorageProvider } from './receipt-storage.js';
import { ReceiptsController } from './receipts.controller.js';
import { ReceiptsService } from './receipts.service.js';

@Module({
  controllers: [ReceiptRecheckController, ReceiptsController], // recheck ก่อน: กัน /recheck ไปชน route :id ของ ReceiptsController
  providers: [
    ReceiptsService,
    receiptStorageProvider,
    receiptExtractorProvider,
  ],
})
export class ReceiptsModule {}
