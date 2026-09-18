import type { CreateDocumentSubmissionDto } from './create-document-submission.dto.js';

export interface BulkDocumentSubmissionEntryDto extends CreateDocumentSubmissionDto {
  vehicleId: unknown;
}

export interface BulkCreateDocumentSubmissionDto {
  entries: unknown; // BulkDocumentSubmissionEntryDto[]
}
