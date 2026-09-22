import { Module } from '@nestjs/common';
import { receiptStorageProvider } from '../receipts/receipt-storage.js';
import { bookReaderProvider } from './book-reader.js';
import { BookPhotosController } from './book-photos.controller.js';
import { BookPhotosService } from './book-photos.service.js';

// รูปเก็บที่เดียวกับใบเสร็จ (key ขึ้นต้น books/)
@Module({
  controllers: [BookPhotosController],
  providers: [BookPhotosService, receiptStorageProvider, bookReaderProvider],
})
export class BookPhotosModule {}
