// กลุ่มของใบส่งงาน/ใบยื่น (ตรงกับที่ปริ้นใน SubmittedRecordsView/JobSheetPrintDialog):
// รย.1 ธรรมดา/ด่วน, รย.2 และ รย.3, มอเตอร์ไซค์ ธรรมดา/ด่วน - 1 ใบยื่น = วันที่ยื่น + กลุ่ม + เจ้าของงาน (ลูกค้า)
export function jobSheetGroup(body: string | null, urgent: boolean): { kind: "car" | "moto"; label: string } {
  const b = body ?? "";
  if (b.startsWith("รย.12-")) return { kind: "moto", label: urgent ? "มอเตอร์ไซค์ แบบด่วน" : "มอเตอร์ไซค์ แบบธรรมดา" };
  if (b.startsWith("รย.1-")) return { kind: "car", label: urgent ? "รย.1 แบบด่วน" : "รย.1 แบบธรรมดา" };
  if (b.startsWith("รย.2-") || b.startsWith("รย.3-")) return { kind: "car", label: "รย.2 และ รย.3" };
  return { kind: "car", label: "ไม่ระบุประเภทรถ" };
}

// กุญแจของใบยื่น 1 ใบ = วันที่ยื่น (YYYY-MM-DD) + กลุ่ม + รหัสลูกค้า - ผู้ใช้ 2026-09-27: ใช้รหัสลูกค้าทุกหน้า (รับใบเสร็จ,
// รับป้าย, รับเล่ม, Delivery, ใบส่งงาน) ชื่อลูกค้าใช้แสดงเท่านั้น (เดิมหน้ารับใบเสร็จ/ป้าย/เล่มใช้ชื่อ ลูกค้าคนละรายที่ชื่อซ้ำกัน
// เช่นคนละสาขา ถูกรวมเป็นใบเดียว แต่หน้า Delivery แยก - ใบยื่นเดียวกันตามข้ามขั้นไม่ได้)
export function jobSheetKey(submitDate: string, label: string, customerId: string): string {
  return `${submitDate}|${label}|${customerId}`;
}

export interface SheetCustomer {
  id: string;
  name: string;
  company?: string | null;
  branch?: string | null;
}

// ชื่อเจ้าของงานที่แสดง (หัวการ์ดใบยื่น / ตัวเลือกเจ้าของงาน / หัวตารางที่ปริ้น) ตามรหัสลูกค้า: ปกติแสดงแค่ชื่อลูกค้า
// ชื่อซ้ำกับลูกค้ารายอื่นในรายการเดียวกัน = ต่อบริษัท · สาขา แบบตัวเลือกลูกค้าตอนบันทึกรถ ให้แยกออกว่าใบไหนของรายไหน
// ยังซ้ำกันอยู่ (ชื่อ บริษัท สาขา เหมือนกันหมด เช่นบันทึกลูกค้าซ้ำ 2 แถว) = ต่อท้าย 4 ตัวท้ายของรหัสลูกค้า - ตัวต่อท้ายนี้
// ไม่ขึ้นกับลำดับ/รายการที่แสดงอยู่ ใบยื่นเดียวกันจึงชื่อเหมือนกันทุกหน้า (ผู้ใช้ 2026-09-27 ใบยื่นแยกตามรหัสลูกค้า)
export function customerDisplayNames(customers: Iterable<SheetCustomer>): Map<string, string> {
  const byId = new Map<string, SheetCustomer>();
  for (const c of customers) if (!byId.has(c.id)) byId.set(c.id, c);
  const countOf = (values: Iterable<string>) => {
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return counts;
  };
  const sameName = countOf([...byId.values()].map((c) => c.name));
  const names = new Map<string, string>();
  for (const c of byId.values()) {
    const detail = (sameName.get(c.name) ?? 0) > 1 ? [c.company?.trim(), c.branch?.trim()] : [];
    names.set(c.id, [c.name, ...detail].filter(Boolean).join(" · "));
  }
  const sameLabel = countOf(names.values());
  for (const [id, label] of names) if ((sameLabel.get(label) ?? 0) > 1) names.set(id, `${label} · รหัส ${id.slice(-4)}`);
  return names;
}
