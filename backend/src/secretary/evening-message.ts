// ประกอบการ์ดไลน์ "สรุปเย็น" (ผู้ใช้ 2026-10-07): ใช้จริงวันนี้ / ปัญหา / วันนี้ทำอะไรไปบ้าง / พนักงานทำอะไร / พรุ่งนี้อย่าลืม
// ผู้ใช้ 2026-10-08: "ข้อมูลควรครบก่อน" - ทุกหัวข้อแสดงครบทุกรายการ (เดิมตัดเหลือ 3-5 บรรทัด แล้วปุ่มดูรายละเอียดก็ไม่มีส่วนที่ตัดไป)
// ฟังก์ชันล้วน ไม่แตะฐานข้อมูล - SecretaryService เป็นคนรวบรวมข้อมูลมาให้
import { baht, bubble, capList, moreLine, overflowTexts, section, tapTo, text, tile, tileRow, TONES, urlFor } from './card-parts.js';
import type { LineMessage } from './line-client.js';

export interface EveningInput {
  today: string; // YYYY-MM-DD (เวลาไทย)
  spend: { today: { total: number } };
  process: Array<{ label: string; done: { car: number | null; moto: number | null; unsplit?: number } }>;
  alerts: Array<{ severity: string; title: string; detail: string; href?: string }>;
  workingCapital: { overdue: { customers: Array<{ customerName: string; amount: number }> } };
  // รายคนจากที่ระบบจดชื่อคนทำไว้ (ผู้ใช้ 2026-10-08): ใส่รถ / ยื่นเอกสาร / รับใบเสร็จ / แก้-ยกเลิก / ใบส่งงาน
  // รับป้าย รับเล่ม และงานอื่นๆ ยังไม่จดชื่อคนทำ
  staff: Array<{ name: string; entered: number; submitted: number; received: number; edits: number; slips: number }>;
}

const doneTotal = (done: EveningInput['process'][number]['done']) => (done.car ?? 0) + (done.moto ?? 0) + (done.unsplit ?? 0);

// baseUrl = ที่อยู่เว็บ (ไม่ตั้ง = ไม่มีปุ่ม/ลิงก์) · แตะปัญหา/เรื่องพรุ่งนี้/ช่องตัวเลขเพื่อเข้าหน้างานนั้นได้ (ผู้ใช้ 2026-10-07)
// คืนการ์ด 1 ใบ + ข้อความต่อท้ายเฉพาะเมื่อหัวข้อใดยาวเกินเพดานของการ์ด (SECTION_MAX) - รวมกันแล้วครบทุกรายการเสมอ
export function buildEveningMessage(input: EveningInput, baseUrl?: string): LineMessage[] {
  const problems = input.alerts.filter((a) => a.severity === 'high').map((a) => ({ label: `● ${a.title}${a.detail ? ` - ${a.detail}` : ''}`, path: a.href ?? '/' }));
  const problemList = capList(problems);

  const done = input.process
    .map((p) => ({ label: `${p.label} ${doneTotal(p.done)}`, count: doneTotal(p.done) }))
    .filter((p) => p.count > 0)
    .sort((a, b) => b.count - a.count);
  const doneList = capList(done);

  const staff = input.staff
    .filter((s) => s.entered + s.submitted + s.received + s.edits + s.slips > 0)
    .map(
      (s) =>
        `${s.name}: ${[
          s.entered > 0 ? `ใส่รถ ${s.entered}` : '',
          s.submitted > 0 ? `ยื่น ${s.submitted}` : '',
          s.received > 0 ? `รับใบเสร็จ ${s.received}` : '',
          s.slips > 0 ? `ใบส่งงาน ${s.slips}` : '',
          s.edits > 0 ? `แก้/ยกเลิก ${s.edits} ครั้ง` : '',
        ]
          .filter(Boolean)
          .join(' · ')}`,
    );
  const staffList = capList(staff);

  // พรุ่งนี้อย่าลืม: ตามเงินลูกค้าที่ค้างก่อน (เกินกำหนดนานสุด) แล้วตามด้วยเรื่องไม่ด่วนจากรายการแจ้งเตือน - ครบทุกราย/ทุกเรื่อง
  const reminders = [
    ...input.workingCapital.overdue.customers.map((c) => ({ label: `ตามเงิน ${c.customerName} ${baht(c.amount)}`, path: '/accounting/billing' })),
    ...input.alerts.filter((a) => a.severity !== 'high').map((a) => ({ label: `${a.title}${a.detail ? ` - ${a.detail}` : ''}`, path: a.href ?? '/' })),
  ].map((r, i) => ({ ...r, label: `${i + 1}. ${r.label}` }));
  const reminderList = capList(reminders);

  const body = [
    tileRow(
      tile('ใช้จริงวันนี้', baht(input.spend.today.total), 'neutral', undefined, urlFor(baseUrl, '/')),
      tile('ปัญหา', `${problems.length} เรื่อง`, problems.length > 0 ? 'danger' : 'success', undefined, urlFor(baseUrl, '/vehicles?status=problem')),
    ),
    section(
      'ปัญหา',
      problems.length > 0
        ? [...problemList.shown.map((p) => text(p.label, { size: 'sm', color: TONES.danger.fg, ...tapTo(urlFor(baseUrl, p.path)) })), ...moreLine(problemList.rest.length)]
        : [text('ไม่มีปัญหา', { size: 'sm', color: TONES.success.fg })],
    ),
    section(
      'วันนี้ทำไปแล้ว',
      done.length > 0
        ? [...doneList.shown.map((p) => text(p.label, { size: 'sm' })), ...moreLine(doneList.rest.length)]
        : [text('วันนี้ยังไม่มีงานที่ทำ', { size: 'sm', color: '#888888' })],
    ),
    ...(staff.length > 0
      ? [
          section('พนักงาน', [
            ...staffList.shown.map((line) => text(line, { size: 'sm' })),
            ...moreLine(staffList.rest.length),
            text('ยังไม่จดชื่อคนทำ: รับป้าย รับเล่ม งานอื่นๆ', { size: 'xxs', color: '#888888' }),
          ]),
        ]
      : []),
    ...(reminders.length > 0
      ? [section('พรุ่งนี้อย่าลืม', [...reminderList.shown.map((r) => text(r.label, { size: 'sm', ...tapTo(urlFor(baseUrl, r.path)) })), ...moreLine(reminderList.rest.length)])]
      : []),
  ];

  const overflow = overflowTexts('สรุปเย็น', [
    { title: 'ปัญหา', lines: problemList.rest.map((p) => p.label) },
    { title: 'วันนี้ทำไปแล้ว', lines: doneList.rest.map((p) => p.label) },
    { title: 'พนักงาน', lines: staffList.rest },
    { title: 'พรุ่งนี้อย่าลืม', lines: reminderList.rest.map((r) => r.label) },
  ]);

  return [
    {
      type: 'flex',
      altText: `สรุปเย็น: ใช้จริง ${baht(input.spend.today.total)} · ปัญหา ${problems.length} เรื่อง`,
      contents: bubble('สรุปเย็น', input.today, body, baseUrl),
    },
    ...overflow.map((t): LineMessage => ({ type: 'text', text: t })),
  ];
}
