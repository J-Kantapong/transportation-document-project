import type { DocumentSubmissionOptionsDto } from './document-submission-options.dto.js';

export interface PreviewBulkDocumentSubmissionEntryDto extends DocumentSubmissionOptionsDto {
  vehicleId: unknown;
  // INDIVIDUAL | JURISTIC - undefined = ใช้เจ้าของรถเดิมของรถคันนั้น (แบบเดียวกับ submit)
  ownerType?: unknown;
}

export interface PreviewBulkDocumentSubmissionDto {
  entries: unknown; // PreviewBulkDocumentSubmissionEntryDto[]
}
