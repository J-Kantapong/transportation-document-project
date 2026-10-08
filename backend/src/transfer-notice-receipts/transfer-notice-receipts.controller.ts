import { Body, Controller, Get, Param, Patch, Post, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_RECEIPT_BYTES } from '../receipts/receipts.service.js';
import { TransferNoticeReceiptsService, type TransferNoticeReceiptFile } from './transfer-notice-receipts.service.js';

// ใบเสร็จแจ้งย้ายของรถจดใหม่ ขั้น 2 (ผู้ใช้ 2026-10-08) - สิทธิ์เขียนเท่ากับการบันทึกแจ้งย้าย (ADMIN / STAFF_ENTRY / STAFF_MOTO เฉพาะจักรยานยนต์)
// อ่าน = พนักงานทุกฝ่าย + บัญชี (ดู access-policy.ts)
@Controller('api/transfer-notice-receipts')
export class TransferNoticeReceiptsController {
  constructor(private readonly service: TransferNoticeReceiptsService) {}

  // multipart: file, vehicleIds ("id1,id2"), totalAmount, amounts (JSON { vehicleId: amount } ไม่บังคับ - ไม่ส่ง = หารเท่ากัน)
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES } }))
  attach(
    @UploadedFile() file: TransferNoticeReceiptFile | undefined,
    @Body() body: { vehicleIds?: unknown; totalAmount?: unknown; amounts?: unknown },
  ) {
    return this.service.attach(file, body);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Get(':id/file')
  async file(@Param('id') id: string) {
    const { data, mimeType, fileName } = await this.service.getFile(id);
    return new StreamableFile(data, { type: mimeType, disposition: `inline; filename="${fileName}"` });
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { totalAmount?: unknown; amounts?: unknown; remark?: unknown }) {
    return this.service.update(id, body);
  }

  @Post(':id/detach')
  detach(@Param('id') id: string, @Body() body: { vehicleId?: unknown; remark?: unknown }) {
    return this.service.detach(id, body);
  }
}
