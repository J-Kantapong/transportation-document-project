// คำสั่งที่พิมพ์ในไลน์ (ผู้ใช้ 2026-10-07 เลือกแบบ A: คำสั่งสั้นๆ ไม่ใช้ AI จึงไม่กิน token) - จับด้วยคำสำคัญ ไม่ต้องพิมพ์ตรงเป๊ะ
export type Command = 'morning' | 'evening' | 'overdue' | 'stuck' | 'spend' | 'help';

// เรียงตามลำดับความสำคัญ: เช้า/เย็นก่อน (ไม่งั้น "สรุปเย็นวันนี้ใช้" จะไปตกคำสั่งยอดใช้จ่าย)
const KEYWORDS: Array<[Command, string[]]> = [
  ['morning', ['เช้า', 'morning']],
  ['evening', ['เย็น', 'evening']],
  ['overdue', ['ค้าง', 'เกินกำหนด', 'ตามเงิน', 'overdue']],
  ['stuck', ['ติด', 'stuck']],
  ['spend', ['ใช้', 'ยอด', 'spend']],
];

export function parseCommand(input: string): Command {
  const text = input.toLowerCase().replace(/\s+/g, '');
  for (const [command, words] of KEYWORDS) {
    if (words.some((w) => text.includes(w))) return command;
  }
  return 'help';
}

// ปุ่มลัดใต้ทุกคำตอบ - บนมือถือกดแทนพิมพ์ (label ยาวได้ไม่เกิน 20 ตัวอักษรตามข้อจำกัด LINE)
export const QUICK_COMMANDS: Array<{ label: string; text: string }> = [
  { label: 'สรุปเช้า', text: 'สรุปเช้า' },
  { label: 'สรุปเย็น', text: 'สรุปเย็น' },
  { label: 'ค้างจ่าย', text: 'ค้างจ่าย' },
  { label: 'รถติดขัด', text: 'รถติดขัด' },
  { label: 'ยอดใช้จ่าย', text: 'ยอดใช้จ่าย' },
  { label: 'ตู้เอกสาร', text: 'ตู้เอกสาร' },
  { label: 'คำสั่งทั้งหมด', text: 'คำสั่ง' },
];
