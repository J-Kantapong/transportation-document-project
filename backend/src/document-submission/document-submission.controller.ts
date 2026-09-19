import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { DocumentSubmissionOptionsDto } from './dto/document-submission-options.dto.js';
import type { CreateDocumentSubmissionDto } from './dto/create-document-submission.dto.js';
import type { BulkCreateDocumentSubmissionDto } from './dto/bulk-create-document-submission.dto.js';
import { DocumentSubmissionService } from './document-submission.service.js';

@Controller('api/vehicles')
export class DocumentSubmissionController {
  constructor(private readonly documentSubmissionService: DocumentSubmissionService) {}

  @Post(':id/document-submission/preview')
  preview(@Param('id') id: string, @Body() body: DocumentSubmissionOptionsDto) {
    return this.documentSubmissionService.preview(id, body);
  }

  @Post(':id/document-submission')
  submit(@Param('id') id: string, @Body() body: CreateDocumentSubmissionDto) {
    return this.documentSubmissionService.submit(id, body);
  }

  @Post('document-submission/bulk')
  submitBulk(@Body() body: BulkCreateDocumentSubmissionDto) {
    return this.documentSubmissionService.submitBulk(body);
  }

  @Get('document-submission')
  list(@Query('date') date?: string, @Query('status') status?: string) {
    return this.documentSubmissionService.listByDate(date, status);
  }

  @Patch('document-submission/:id/status')
  updateStatus(@Param('id') id: string, @Body() body: { status?: unknown; receivedDate?: unknown }) {
    return this.documentSubmissionService.updateStatus(id, body?.status, body?.receivedDate);
  }
}
