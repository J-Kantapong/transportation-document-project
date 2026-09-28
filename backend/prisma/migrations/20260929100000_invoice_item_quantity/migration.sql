-- จำนวน x ราคาต่อหน่วยของบรรทัดกำหนดเอง (ผู้ใช้ 2026-09-29) - แถวที่มีอยู่เป็น 1 หน่วย ราคาต่อหน่วย = ยอดเดิม
ALTER TABLE "InvoiceItem" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "InvoiceItem" ADD COLUMN "unitPrice" DECIMAL(12,2);
UPDATE "InvoiceItem" SET "unitPrice" = "amount";
ALTER TABLE "InvoiceItem" ALTER COLUMN "unitPrice" SET NOT NULL;
