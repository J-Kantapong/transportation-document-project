-- Track whether a document submission is still pending a receipt from the DLT, so the same
-- vehicle can be blocked from being submitted again until it either gets the receipt or the
-- submission is marked failed. See the comment above DocumentSubmission in schema.prisma.

-- AlterTable
ALTER TABLE "DocumentSubmission"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
