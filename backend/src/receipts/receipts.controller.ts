import { Body, Controller, Delete, Get, Param, Patch, Post, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_RECEIPT_BYTES, ReceiptsService, type UploadedReceiptFile } from './receipts.service.js';

@Controller('api/receipts')
export class ReceiptsController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  // multipart/form-data: file = รูปใบเสร็จ, submissionId (ไม่บังคับ) = รายการที่ยื่นเอกสาร
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 } }))
  upload(@UploadedFile() file: UploadedReceiptFile | undefined, @Body() body: { submissionId?: unknown }) {
    return this.receiptsService.upload(file, body?.submissionId);
  }

  @Get('unassigned')
  listUnassigned() {
    return this.receiptsService.listUnassigned();
  }

  @Get(':id/image')
  async image(@Param('id') id: string) {
    const { data, mimeType } = await this.receiptsService.getImage(id);
    return new StreamableFile(data, { type: mimeType, disposition: 'inline' });
  }

  @Patch(':id')
  assign(@Param('id') id: string, @Body() body: { submissionId?: unknown }) {
    return this.receiptsService.assign(id, body?.submissionId);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.receiptsService.remove(id);
  }
}
