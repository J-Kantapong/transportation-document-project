// ชิ้นส่วนร่วมของการ์ดไลน์ (Flex message) ของเลขา - สรุปเช้า/เย็นใช้หน้าตาเดียวกัน (ผู้ใช้ 2026-10-07)
export type Tone = 'danger' | 'warning' | 'success' | 'neutral';

export const TONES: Record<Tone, { bg: string; fg: string }> = {
  danger: { bg: '#FCEBEB', fg: '#A32D2D' },
  warning: { bg: '#FAEEDA', fg: '#854F0B' },
  success: { bg: '#EAF3DE', fg: '#3B6D11' },
  neutral: { bg: '#F1EFE8', fg: '#444441' },
};

const WEEKDAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

export function thaiDayLabel(iso: string): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

// ยอดเงินเต็ม (ทศนิยมเท่าที่มี ไม่เกิน 2 ตำแหน่ง) เช่น ฿45,230 / ฿1,250.5
export function baht(amount: number): string {
  return `฿${amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export const text = (value: string, extra: Record<string, unknown> = {}) => ({ type: 'text', text: value, wrap: true, ...extra });

// ลิงก์เข้าหน้างานของเว็บ (ผู้ใช้ 2026-10-07): base = ที่อยู่เว็บ (FRONTEND_ORIGIN) ไม่ตั้ง = ไม่มีลิงก์ การ์ดยังใช้ได้ตามปกติ
export function urlFor(base: string | undefined, path: string): string | undefined {
  return base ? `${base.replace(/\/+$/, '')}${path}` : undefined;
}

// แตะส่วนนั้นของการ์ดแล้วเปิดลิงก์ (ใส่ใน text หรือ box ได้)
export const tapTo = (uri: string | undefined): Record<string, unknown> => (uri ? { action: { type: 'uri', label: 'เปิด', uri } } : {});

export function tile(label: string, value: string, tone: Tone, sub?: string, uri?: string) {
  const { bg, fg } = TONES[tone];
  return {
    type: 'box',
    ...tapTo(uri),
    layout: 'vertical',
    flex: 1,
    backgroundColor: bg,
    cornerRadius: '8px',
    paddingAll: '10px',
    spacing: 'xs',
    contents: [
      text(label, { size: 'xs', color: fg }),
      text(value, { size: 'xl', weight: 'bold', color: fg }),
      ...(sub ? [text(sub, { size: 'xxs', color: fg })] : []),
    ],
  };
}

export const tileRow = (left: ReturnType<typeof tile>, right: ReturnType<typeof tile>) => ({
  type: 'box',
  layout: 'horizontal',
  spacing: 'sm',
  contents: [left, right],
});

export function section(title: string, lines: Array<Record<string, unknown>>) {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    margin: 'lg',
    contents: [text(title, { size: 'xs', color: '#888888' }), ...lines],
  };
}

export function bubble(title: string, today: string, body: unknown[], baseUrl?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'horizontal',
      contents: [text(title, { weight: 'bold', size: 'md', flex: 1 }), text(thaiDayLabel(today), { size: 'xs', color: '#888888', align: 'end' })],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
  };
  const homeUrl = urlFor(baseUrl, '/');
  if (homeUrl) {
    out.footer = {
      type: 'box',
      layout: 'vertical',
      contents: [{ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: 'ดูรายละเอียด', uri: homeUrl } }],
    };
  }
  return out;
}

// ผู้ใช้ 2026-10-08: "ข้อมูลควรครบก่อน" - การ์ดแสดงทุกรายการ ไม่ตัดเหลือ 3-5 บรรทัดเหมือนเดิม
// เพดานต่อหัวข้อมีไว้กันการ์ดเกินขนาดที่ LINE รับ (bubble ละ 30 KB) เท่านั้น - ส่วนที่เกินเพดานไม่หาย ไปต่อในข้อความถัดไป (overflowText)
export const SECTION_MAX = 15;

export interface Listed<T> {
  shown: T[];
  rest: T[];
}

export function capList<T>(items: T[], max = SECTION_MAX): Listed<T> {
  return { shown: items.slice(0, max), rest: items.slice(max) };
}

// เกินเพดาน -> บอกในการ์ดว่ามีต่อในข้อความถัดไป
export function moreLine(rest: number) {
  return rest > 0 ? [text(`และอีก ${rest} รายการ (ต่อในข้อความถัดไป)`, { size: 'xs', color: '#888888' })] : [];
}

// ข้อความต่อท้ายการ์ด: รายการที่เกินเพดานของแต่ละหัวข้อ ครบทุกบรรทัด - ไม่มีอะไรเกิน = ไม่ส่ง
// แบ่งเป็นหลายข้อความเมื่อยาวเกินที่ LINE รับต่อข้อความ (5,000 ตัวอักษร) โดยตัดที่ขึ้นบรรทัดใหม่
const TEXT_CHUNK = 4500;

export function overflowTexts(title: string, sections: Array<{ title: string; lines: string[] }>): string[] {
  const lines = sections.filter((s) => s.lines.length > 0).flatMap((s) => ['', `${s.title} (ต่อ)`, ...s.lines]);
  if (lines.length === 0) return [];
  const chunks: string[] = [];
  let current = `${title} (ต่อ)`;
  for (const line of lines) {
    if (current.length + 1 + line.length > TEXT_CHUNK) {
      chunks.push(current);
      current = `${title} (ต่อ)`;
    }
    current += `\n${line}`;
  }
  chunks.push(current);
  return chunks;
}
