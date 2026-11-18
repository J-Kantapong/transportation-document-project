// คำสั่งที่พิมพ์ในไลน์ (ผู้ใช้ 2026-10-07 เลือกแบบ A: คำสั่งสั้นๆ ไม่ใช้ AI จึงไม่กิน token) - จับด้วยคำสำคัญ ไม่ต้องพิมพ์ตรงเป๊ะ
// menu = ข้อความที่ไม่ตรงคำสั่งไหน ตอบเป็นการ์ดเมนู (ผู้ใช้ 2026-11-18) · help = รายการคำสั่งแบบข้อความ ต้องพิมพ์ "คำสั่ง" เอง
export type Command = 'morning' | 'evening' | 'finance' | 'overdue' | 'stuck' | 'spend' | 'reminders' | 'help' | 'menu';

// เรียงตามลำดับความสำคัญ: เช้า/เย็นก่อน (ไม่งั้น "สรุปเย็นวันนี้ใช้" จะไปตกคำสั่งยอดใช้จ่าย)
const KEYWORDS: Array<[Command, string[]]> = [
  ['morning', ['เช้า', 'morning']],
  ['evening', ['เย็น', 'evening']],
  // ก่อน overdue: "การเงินค้าง" มีคำว่า "ค้าง" (ผู้ใช้ 2026-10-31)
  ['finance', ['การเงิน', 'finance']],
  ['overdue', ['ค้าง', 'เกินกำหนด', 'ตามเงิน', 'overdue']],
  // ตารางเตือนประจำสัปดาห์ (ผู้ใช้ 2026-10-31) - ก่อน stuck/spend ไม่ให้ "ตารางเตือน" ไปตกคำอื่น
  ['reminders', ['เตือน', 'reminder']],
  ['stuck', ['ติด', 'stuck']],
  ['spend', ['ใช้', 'ยอด', 'spend']],
  ['help', ['คำสั่ง', 'help']],
];

export function parseCommand(input: string): Command {
  const text = input.toLowerCase().replace(/\s+/g, '');
  for (const [command, words] of KEYWORDS) {
    if (words.some((w) => text.includes(w))) return command;
  }
  return 'menu';
}

// ปุ่มลัดใต้ทุกคำตอบ - บนมือถือกดแทนพิมพ์ (label ยาวได้ไม่เกิน 20 ตัวอักษรตามข้อจำกัด LINE)
// ผู้ใช้ 2026-11-18 "อยากมองอะไรง่ายๆ": เหลือเฉพาะเรื่องที่ใช้บ่อย ที่เหลืออยู่ในการ์ดเมนู (ปุ่มแรก) และ "คำสั่ง"
// บางปุ่มเป็นคำสั่งค้นข้อมูลของ lookup.ts (เมนู / งานค้าง / ราคา / ต้นทุน / ใบเสนอราคา) หรือลิงก์เอกสารของ invoice-link.ts
export const QUICK_COMMANDS: Array<{ label: string; text: string }> = [
  { label: 'เมนู', text: 'เมนู' },
  { label: 'งานค้าง', text: 'งานค้าง' },
  { label: 'การเงินค้าง', text: 'การเงินค้าง' },
  { label: 'บิลล่าสุด', text: 'บิลล่าสุด' },
  { label: 'ใบกำกับล่าสุด', text: 'ใบกำกับล่าสุด' },
  { label: 'ใบเสนอราคาล่าสุด', text: 'ใบเสนอราคาล่าสุด' },
  { label: 'ราคาลูกค้า', text: 'ราคา' },
  { label: 'ต้นทุนต่อคัน', text: 'ต้นทุน' },
  { label: 'คำสั่งทั้งหมด', text: 'คำสั่ง' },
];
