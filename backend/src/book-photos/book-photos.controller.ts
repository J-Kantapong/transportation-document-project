import { Body, Controller, Get, Param, Post, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
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

  @Get(':id/image')
  async image(@Param('id') id: string) {
    const { data, mimeType } = await this.bookPhotosService.getImage(id);
    return new StreamableFile(data, { type: mimeType, disposition: 'inline' });
  }
}
