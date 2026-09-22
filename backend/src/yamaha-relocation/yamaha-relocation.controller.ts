import { Body, Controller, Get, Param, Post, Query, StreamableFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { MAX_RECEIPT_BYTES } from '../receipts/receipts.service.js';
import type { CreateYamahaRelocationEntryDto } from './dto/create-yamaha-relocation-entry.dto.js';
import { YamahaRelocationService, type YamahaRelocationFiles } from './yamaha-relocation.service.js';

@Controller('api/yamaha-relocation')
export class YamahaRelocationController {
  constructor(private readonly yamahaRelocationService: YamahaRelocationService) {}

  @Get()
  findForMonth(@Query('size') size: string, @Query('month') month: string) {
    return this.yamahaRelocationService.findForMonth(size, month);
  }

  // multipart/form-data: date, size, count + ไฟล์ receipt (ใบเสร็จ) และ report (Report) อย่างละ 1 ไฟล์ - บังคับทั้งคู่
  @Post()
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'receipt', maxCount: 1 },
        { name: 'report', maxCount: 1 },
      ],
      { limits: { fileSize: MAX_RECEIPT_BYTES, files: 2 } },
    ),
  )
  create(@Body() body: CreateYamahaRelocationEntryDto, @UploadedFiles() files: YamahaRelocationFiles | undefined) {
    return this.yamahaRelocationService.create(body, files);
  }

  @Get('attachments/:id/file')
  async file(@Param('id') id: string) {
    const { data, mimeType, fileName } = await this.yamahaRelocationService.getFile(id);
    return new StreamableFile(data, { type: mimeType, disposition: `inline; filename="${encodeURIComponent(fileName)}"` });
  }
}
