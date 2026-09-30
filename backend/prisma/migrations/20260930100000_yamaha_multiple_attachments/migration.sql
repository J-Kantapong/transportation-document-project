-- Yamaha relocation entries may carry several receipt / report files (user 2026-09-30):
-- replace the one-file-per-kind unique index with a plain index.
DROP INDEX "YamahaRelocationAttachment_entryId_kind_key";
CREATE INDEX "YamahaRelocationAttachment_entryId_kind_idx" ON "YamahaRelocationAttachment"("entryId", "kind");
