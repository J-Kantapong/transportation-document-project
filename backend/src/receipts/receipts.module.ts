import { Module } from '@nestjs/common';
import { receiptExtractorProvider } from './receipt-extractor.js';
import { LocalReceiptStorage, RECEIPT_STORAGE } from './receipt-storage.js';
import { ReceiptsController } from './receipts.controller.js';
import { ReceiptsService } from './receipts.service.js';

@Module({
  controllers: [ReceiptsController],
  providers: [
    ReceiptsService,
    { provide: RECEIPT_STORAGE, useClass: LocalReceiptStorage },
    receiptExtractorProvider,
  ],
})
export class ReceiptsModule {}
