import { Module } from '@nestjs/common';
import { receiptStorageProvider } from '../receipts/receipt-storage.js';
import { TransferNoticeReceiptsController } from './transfer-notice-receipts.controller.js';
import { TransferNoticeReceiptsService } from './transfer-notice-receipts.service.js';

// ไฟล์เก็บที่เดียวกับรูปใบเสร็จ (key ขึ้นต้น transfer-notice/)
@Module({
  controllers: [TransferNoticeReceiptsController],
  providers: [TransferNoticeReceiptsService, receiptStorageProvider],
})
export class TransferNoticeReceiptsModule {}
