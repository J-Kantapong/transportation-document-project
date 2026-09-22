import { Body, Controller, Delete, Get, Param, Post, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_RECEIPT_BYTES, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { BookPhotosService } from './book-photos.service.js';

@Controller('api/book-photos')
export class BookPhotosController {
  constructor(private readonly bookPhotosService: BookPhotosService) {}

  // multipart/form-data: file = รูปเล่มทะเบียน (เล่มเดียวหรือหลายเล่มในรูปเดียว)
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 } }))
  upload(@UploadedFile() file: UploadedReceiptFile | undefined) {
    return this.bookPhotosService.upload(file);
  }

  @Get('open')
  listOpen() {
    return this.bookPhotosService.listOpen();
  }

  @Get(':id/image')
  async image(@Param('id') id: string) {
    const { data, mimeType } = await this.bookPhotosService.getImage(id);
    return new StreamableFile(data, { type: mimeType, disposition: 'inline' });
  }

  // { date: 'YYYY-MM-DD', items: [{ vehicleId, photoId }], closePhotoIds: [...] }
  @Post('confirm')
  confirm(@Body() body: { date?: unknown; items?: unknown; closePhotoIds?: unknown }) {
    return this.bookPhotosService.confirm(body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.bookPhotosService.remove(id);
  }
}
