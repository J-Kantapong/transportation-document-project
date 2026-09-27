import { Body, Controller, Delete, Get, Param, Patch, Post, Query, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_RECEIPT_BYTES, ReceiptsService, type UploadedReceiptFile } from './receipts.service.js';

@Controller('api/receipts')
export class ReceiptsController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  // multipart/form-data: file = รูปใบเสร็จ, submissionId (ไม่บังคับ) = รายการที่ยื่นเอกสาร
  // background=1 (ไม่ระบุรถเท่านั้น) = เก็บรูปแล้วตอบทันที AI อ่านทีหลัง - ดูผลด้วย GET /api/receipts?ids=
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 } }))
  upload(@UploadedFile() file: UploadedReceiptFile | undefined, @Body() body: { submissionId?: unknown; background?: unknown }) {
    return this.receiptsService.upload(file, body?.submissionId, body?.background);
  }

  @Get()
  findByIds(@Query('ids') ids: unknown) {
    return this.receiptsService.findByIds(ids);
  }

  // ถาดรูปรอจับคู่ - ตอบ { receipts, total, hasMore } โหลดเพิ่มด้วย offset (limit ไม่ส่ง = 200)
  @Get('unassigned')
  listUnassigned(@Query('offset') offset?: string, @Query('limit') limit?: string) {
    return this.receiptsService.listUnassigned(offset, limit);
  }

  @Get(':id/image')
  async image(@Param('id') id: string) {
    const { data, mimeType } = await this.receiptsService.getImage(id);
    return new StreamableFile(data, { type: mimeType, disposition: 'inline' });
  }

  // unassignedOnly = จับคู่จากถาด: รูปถูกจับคู่กับรถคันอื่นไปแล้วตอบ 409
  @Patch(':id')
  assign(@Param('id') id: string, @Body() body: { submissionId?: unknown; unassignedOnly?: unknown }) {
    return this.receiptsService.assign(id, body?.submissionId, body?.unassignedOnly);
  }

  // ?unassignedOnly=1 = ลบจากถาด/หน้าถ่าย: รูปถูกจับคู่กับรถไปแล้วตอบ 409 ไม่ลบ
  @Delete(':id')
  remove(@Param('id') id: string, @Query('unassignedOnly') unassignedOnly?: string) {
    return this.receiptsService.remove(id, unassignedOnly);
  }
}
