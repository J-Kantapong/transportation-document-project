// ร่างรายการยื่นเอกสาร (บันทึกไว้แต่ยังไม่ยื่นจริง) เก็บใน localStorage ของเบราว์เซอร์ - ใช้ร่วมกันระหว่างหน้าเมนู
// (แสดงจำนวนคันที่ค้างอยู่) กับหน้ายื่นเอกสาร (กู้คืนรายการเต็มแล้วคำนวณค่าธรรมเนียม/ภาษีใหม่)
export const DRAFT_STORAGE_KEY = "submit-documents-draft-v1";

export interface DraftSummary {
  count: number;
  submitDate: string; // ISO
}

// อ่านเฉพาะจำนวนคันกับวันที่ยื่นของร่าง - ไม่ต้องคำนวณราคา ใช้แสดงป้ายเตือนบนหน้าเมนู
export function readDraftSummary(): DraftSummary | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw) as { submitDate?: string; entries?: unknown[] };
    if (!draft?.entries?.length || !draft.submitDate) return null;
    return { count: draft.entries.length, submitDate: draft.submitDate };
  } catch {
    return null;
  }
}
