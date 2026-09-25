import { Module } from '@nestjs/common';
import { receiptStorageProvider } from '../receipts/receipt-storage.js';
import { PlatePhotosController } from './plate-photos.controller.js';
import { PlatePhotosService } from './plate-photos.service.js';

// รูปเก็บที่เดียวกับใบเสร็จ (key ขึ้นต้น plates/)
@Module({
  controllers: [PlatePhotosController],
  providers: [PlatePhotosService, receiptStorageProvider],
})
export class PlatePhotosModule {}
