import type { Prisma } from '../generated/prisma/client.js';

// ล็อกแถวรายการที่ยื่น (SELECT ... FOR UPDATE) จนจบ transaction แล้วคืนสถานะล่าสุดของแต่ละแถว (id ที่ไม่อยู่ใน Map = ถูกยกเลิก/ลบไปแล้ว)
// ใช้ทั้งตอนแนบ/ย้าย/ลบรูปใบเสร็จ (ReceiptsService) และตอนบันทึกผลรับใบเสร็จ/ยกเลิกรายการ (DocumentSubmissionService)
// ให้สองทางทำทีละคำขอ: คำสั่งถัดไปใน transaction เห็นสิ่งที่อีกฝั่งบันทึกไปแล้ว (พบ 2026-09-27: เดิมตรวจแล้วค่อยเขียนกันคนละแถว
// แนบรูปพร้อมกับที่อีกคนบันทึกยื่นไม่สำเร็จ รูปไปค้างกับรายการที่ไม่มีหน้าไหนเข้าถึง หรือย้ายรูปออกจากรายการที่เพิ่งได้ใบเสร็จ)
// ล็อกแถวรายการก่อนแถวรูปเสมอ และหลายแถวเรียงตาม id กัน deadlock
export async function lockSubmissions(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))].sort();
  if (unique.length === 0) return new Map();
  const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT "id", "status" FROM "DocumentSubmission" WHERE "id" = ANY(${unique}::text[]) ORDER BY "id" FOR UPDATE`;
  return new Map(rows.map((r) => [r.id, r.status]));
}
