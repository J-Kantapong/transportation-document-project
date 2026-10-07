// ตู้ข้อความในไลน์ (ผู้ใช้ 2026-10-07): จำ <ชื่อ> = <ข้อความ> · ขอ <ชื่อ> · ลืม <ชื่อ> · ตู้เอกสาร
// ส่วนแยกคำสั่งเป็นฟังก์ชันล้วน ทดสอบแยกได้ (NotesService ทำงานกับฐานข้อมูล)
export type NoteCommand =
  | { type: 'save'; title: string; value: string }
  | { type: 'get'; query: string }
  | { type: 'forget'; query: string }
  | { type: 'list' }
  | { type: 'invalid-save' };

export const MAX_TITLE_LENGTH = 60;
export const MAX_VALUE_LENGTH = 2000;
export const MAX_NOTES = 200;

// key ใช้เทียบชื่อ: ตัดช่องว่างทั้งหมด + ตัวพิมพ์เล็ก ("ที่อยู่ บริษัท" = "ที่อยู่บริษัท")
export function noteKey(title: string): string {
  return title.toLowerCase().replace(/\s+/g, '');
}

// คืน null = ไม่ใช่คำสั่งตู้ข้อความ (ให้ไปจับเป็นคำสั่งสรุป/ช่วยเหลือต่อ)
export function parseNoteCommand(input: string): NoteCommand | null {
  const text = input.trim();

  const save = /^จำ\s*([\s\S]*)$/.exec(text);
  if (save) {
    // แยกที่ = หรือ : ตัวแรก ส่วนหลังเก็บทั้งหมด (ขึ้นบรรทัดใหม่ได้ เช่น ที่อยู่หลายบรรทัด)
    const m = /^([^=:\n]+?)\s*[=:]\s*([\s\S]+)$/.exec(save[1]);
    if (!m) return { type: 'invalid-save' };
    return { type: 'save', title: m[1].trim(), value: m[2].trim() };
  }

  const forget = /^ลืม\s+(.+)$/.exec(text);
  if (forget) return { type: 'forget', query: forget[1].trim() };

  const get = /^ขอ\s*(.+)$/.exec(text);
  if (get) return { type: 'get', query: get[1].trim() };

  if (/^ตู้(เอกสาร|ข้อความ)?$/.test(text.replace(/\s+/g, ''))) return { type: 'list' };
  return null;
}

export const NOTES_HELP = [
  'ตู้ข้อความ',
  '• จำ ที่อยู่บริษัท = 123 ถ.… (จำใหม่/ทับของเดิม)',
  '• ขอ ที่อยู่ (ขอข้อความคืน พิมพ์แค่บางคำก็หาเจอ)',
  '• ลืม ที่อยู่บริษัท',
  '• ตู้เอกสาร (ดูรายการ)',
  'ห้ามเก็บรหัสผ่านหรือเลขบัตรประชาชน',
].join('\n');
