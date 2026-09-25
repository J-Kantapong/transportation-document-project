import { Body, Controller, Get, Param, Post, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_RECEIPT_BYTES, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { PlatePhotosService } from './plate-photos.service.js';

@Controller('api/plate-photos')
export class PlatePhotosController {
  constructor(private readonly platePhotosService: PlatePhotosService) {}

  // multipart/form-data: file = รูปป้ายทะเบียนของรถคันนี้, vehicleId, date = YYYY-MM-DD -> บันทึกรับทันที (ไม่มี AI แล้ว)
  @Post('attach')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 } }))
  attach(@UploadedFile() file: UploadedReceiptFile | undefined, @Body() body: { vehicleId?: unknown; date?: unknown }) {
    return this.platePhotosService.attach(file, body?.vehicleId, body?.date);
  }

  @Get(':id/image')
  async image(@Param('id') id: string) {
    const { data, mimeType } = await this.platePhotosService.getImage(id);
    return new StreamableFile(data, { type: mimeType, disposition: 'inline' });
  }
}
