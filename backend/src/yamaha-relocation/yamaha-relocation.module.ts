import { Module } from '@nestjs/common';
import { receiptStorageProvider } from '../receipts/receipt-storage.js';
import { YamahaRelocationController } from './yamaha-relocation.controller.js';
import { YamahaRelocationService } from './yamaha-relocation.service.js';

// ไฟล์แนบ (ใบเสร็จ/Report) เก็บที่เดียวกับรูปใบเสร็จ (key ขึ้นต้น yamaha-relocation/)
@Module({
  controllers: [YamahaRelocationController],
  providers: [YamahaRelocationService, receiptStorageProvider],
})
export class YamahaRelocationModule {}
