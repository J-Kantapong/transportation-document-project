import { Body, Controller, Get, Param, Patch, Post, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
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

  // แก้วันที่รับป้าย { date: YYYY-MM-DD, remark } - ก่อนส่งป้ายให้ลูกค้าเท่านั้น (ผู้ใช้ 2026-09-27)
  @Patch('vehicle/:vehicleId/received-date')
  updateReceivedDate(@Param('vehicleId') vehicleId: string, @Body() body: { date?: unknown; remark?: unknown }) {
    return this.platePhotosService.updateReceivedDate(vehicleId, body ?? {});
  }

  // ถอดรูปป้ายที่แนบผิด { remark } -> รถกลับเข้าคิวรอรับป้าย (ผู้ใช้ 2026-09-27)
  @Post('vehicle/:vehicleId/detach')
  detach(@Param('vehicleId') vehicleId: string, @Body() body: { remark?: unknown }) {
    return this.platePhotosService.detach(vehicleId, body ?? {});
  }

  @Get(':id/image')
  async image(@Param('id') id: string) {
    const { data, mimeType } = await this.platePhotosService.getImage(id);
    return new StreamableFile(data, { type: mimeType, disposition: 'inline' });
  }
}
