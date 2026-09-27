import { Body, Controller, Get, Param, Patch, Post, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_RECEIPT_BYTES, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { BookPhotosService } from './book-photos.service.js';

@Controller('api/book-photos')
export class BookPhotosController {
  constructor(private readonly bookPhotosService: BookPhotosService) {}

  // multipart/form-data: file = รูปเล่มทะเบียนของรถคันนี้, vehicleId, date = YYYY-MM-DD -> บันทึกรับทันที (ไม่มี AI แล้ว)
  @Post('attach')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 } }))
  attach(@UploadedFile() file: UploadedReceiptFile | undefined, @Body() body: { vehicleId?: unknown; date?: unknown }) {
    return this.bookPhotosService.attach(file, body?.vehicleId, body?.date);
  }

  // แก้วันที่รับเล่ม { date: YYYY-MM-DD, remark } - ก่อนส่งเล่มให้ลูกค้าเท่านั้น (ผู้ใช้ 2026-09-27)
  @Patch('vehicle/:vehicleId/received-date')
  updateReceivedDate(@Param('vehicleId') vehicleId: string, @Body() body: { date?: unknown; remark?: unknown }) {
    return this.bookPhotosService.updateReceivedDate(vehicleId, body ?? {});
  }

  // ถอดรูปเล่มที่แนบผิด { remark } -> รถกลับเข้าคิวรอรับเล่ม (ผู้ใช้ 2026-09-27)
  @Post('vehicle/:vehicleId/detach')
  detach(@Param('vehicleId') vehicleId: string, @Body() body: { remark?: unknown }) {
    return this.bookPhotosService.detach(vehicleId, body ?? {});
  }

  @Get(':id/image')
  async image(@Param('id') id: string) {
    const { data, mimeType } = await this.bookPhotosService.getImage(id);
    return new StreamableFile(data, { type: mimeType, disposition: 'inline' });
  }
}
