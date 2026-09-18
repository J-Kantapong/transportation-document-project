import { Module } from '@nestjs/common';
import { TaxModule } from '../tax/tax.module.js';
import { DocumentSubmissionController } from './document-submission.controller.js';
import { DocumentSubmissionService } from './document-submission.service.js';

@Module({
  imports: [TaxModule],
  controllers: [DocumentSubmissionController],
  providers: [DocumentSubmissionService],
})
export class DocumentSubmissionModule {}
