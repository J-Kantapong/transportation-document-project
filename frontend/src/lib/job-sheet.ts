// กลุ่มของใบส่งงาน/ใบยื่น (ตรงกับที่ปริ้นใน SubmittedRecordsView/JobSheetPrintDialog):
// รย.1 ธรรมดา/ด่วน, รย.2 และ รย.3, มอเตอร์ไซค์ ธรรมดา/ด่วน - 1 ใบยื่น = วันที่ยื่น + กลุ่ม + เจ้าของงาน (ลูกค้า)
export function jobSheetGroup(body: string | null, urgent: boolean): { kind: "car" | "moto"; label: string } {
  const b = body ?? "";
  if (b.startsWith("รย.12-")) return { kind: "moto", label: urgent ? "มอเตอร์ไซค์ แบบด่วน" : "มอเตอร์ไซค์ แบบธรรมดา" };
  if (b.startsWith("รย.1-")) return { kind: "car", label: urgent ? "รย.1 แบบด่วน" : "รย.1 แบบธรรมดา" };
  if (b.startsWith("รย.2-") || b.startsWith("รย.3-")) return { kind: "car", label: "รย.2 และ รย.3" };
  return { kind: "car", label: "ไม่ระบุประเภทรถ" };
}
