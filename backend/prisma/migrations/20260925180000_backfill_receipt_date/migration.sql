-- Backfill DocumentSubmission.receiptDate for receipts already received before the column existed.
-- Source: the date the AI read from the submission's latest receipt photo with a readable date
-- (ReceiptImage.extraction.reading.date, already Gregorian; a Buddhist-era year >= 2400 is converted by
-- subtracting 543 just in case). No readable date, or an impossible one, falls back to submitDate,
-- the same default the API uses (DLT issues the receipt on the submit day).
CREATE FUNCTION pg_temp.receipt_read_date(raw text) RETURNS date AS $$
DECLARE
  y int;
BEGIN
  IF raw IS NULL OR raw !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RETURN NULL;
  END IF;
  y := substr(raw, 1, 4)::int;
  IF y >= 2400 THEN
    y := y - 543;
  END IF;
  RETURN make_date(y, substr(raw, 6, 2)::int, substr(raw, 9, 2)::int);
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

UPDATE "DocumentSubmission" s
SET "receiptDate" = COALESCE(
  (
    SELECT pg_temp.receipt_read_date(r.extraction -> 'reading' ->> 'date')::timestamp
    FROM "ReceiptImage" r
    WHERE r."submissionId" = s.id
      AND pg_temp.receipt_read_date(r.extraction -> 'reading' ->> 'date') IS NOT NULL
    ORDER BY r."createdAt" DESC
    LIMIT 1
  ),
  s."submitDate"
)
WHERE s.status = 'RECEIPT_RECEIVED' AND s."receiptDate" IS NULL;
