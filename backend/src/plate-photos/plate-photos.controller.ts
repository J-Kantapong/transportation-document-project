import { Body, Controller, Delete, Get, Param, Post, Query, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_RECEIPT_BYTES, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { PlatePhotosService } from './plate-photos.service.js';

@Controller('api/plate-photos')
export class PlatePhotosController {
  constructor(private readonly platePhotosService: PlatePhotosService) {}

  // multipart/form-data: file = รูปป้ายทะเบียน (แผ่นเดียวหรือหลายแผ่นในรูปเดียว), kind = car | moto (แท็บที่ถ่าย)
  // background=1 = เก็บรูปแล้วตอบทันที AI อ่านทีหลัง - หน้าเว็บดูผลจาก GET open (readPending)
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 } }))
  upload(@UploadedFile() file: UploadedReceiptFile | undefined, @Body() body: { kind?: unknown; background?: unknown }) {
    return this.platePhotosService.upload(file, body?.kind, body?.background);
  }

  // ?kind=car | moto
  @Get('open')
  listOpen(@Query('kind') kind: unknown) {
    return this.platePhotosService.listOpen(kind);
  }

  @Get(':id/image')
  async image(@Param('id') id: string) {
    const { data, mimeType } = await this.platePhotosService.getImage(id);
    return new StreamableFile(data, { type: mimeType, disposition: 'inline' });
  }

  // { date: 'YYYY-MM-DD', items: [{ vehicleId, photoId }], closePhotoIds: [...] }
  @Post('confirm')
  confirm(@Body() body: { date?: unknown; items?: unknown; closePhotoIds?: unknown }) {
    return this.platePhotosService.confirm(body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.platePhotosService.remove(id);
  }
}
