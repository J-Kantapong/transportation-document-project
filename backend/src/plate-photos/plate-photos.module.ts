import { Module } from '@nestjs/common';
import { LocalReceiptStorage, RECEIPT_STORAGE } from '../receipts/receipt-storage.js';
import { plateReaderProvider } from './plate-reader.js';
import { PlatePhotosController } from './plate-photos.controller.js';
import { PlatePhotosService } from './plate-photos.service.js';

// รูปเก็บที่เดียวกับใบเสร็จ (key ขึ้นต้น plates/)
@Module({
  controllers: [PlatePhotosController],
  providers: [PlatePhotosService, { provide: RECEIPT_STORAGE, useClass: LocalReceiptStorage }, plateReaderProvider],
})
export class PlatePhotosModule {}
