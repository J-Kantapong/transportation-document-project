// ประกอบการ์ดไลน์ "สรุปเย็น" (ผู้ใช้ 2026-10-07): ใช้จริงวันนี้ / ปัญหา / วันนี้ทำอะไรไปบ้าง / พนักงานทำอะไร / พรุ่งนี้อย่าลืม
// ฟังก์ชันล้วน ไม่แตะฐานข้อมูล - SecretaryService เป็นคนรวบรวมข้อมูลมาให้
import { baht, bubble, moreLine, section, tapTo, text, tile, tileRow, TONES, urlFor } from './card-parts.js';
import type { LineMessage } from './line-client.js';

export interface EveningInput {
  today: string; // YYYY-MM-DD (เวลาไทย)
  spend: { today: { total: number } };
  process: Array<{ label: string; done: { car: number | null; moto: number | null; unsplit?: number } }>;
  alerts: Array<{ severity: string; title: string; detail: string; href?: string }>;
  workingCapital: { overdue: { customers: Array<{ customerName: string; amount: number }> } };
  // รายคนจากประวัติที่ระบบจดชื่อคนทำไว้เท่านั้น (แก้ไข/ยกเลิก + ใบส่งงาน) - การใส่รถ/ยื่นเอกสารยังไม่จดชื่อ
  staff: Array<{ name: string; edits: number; slips: number }>;
}

const MAX_DONE = 4;
const MAX_STAFF = 5;
const MAX_PROBLEMS = 3;
const MAX_REMINDERS = 3;

const doneTotal = (done: EveningInput['process'][number]['done']) => (done.car ?? 0) + (done.moto ?? 0) + (done.unsplit ?? 0);

// baseUrl = ที่อยู่เว็บ (ไม่ตั้ง = ไม่มีปุ่ม/ลิงก์) · แตะปัญหา/เรื่องพรุ่งนี้/ช่องตัวเลขเพื่อเข้าหน้างานนั้นได้ (ผู้ใช้ 2026-10-07)
export function buildEveningMessage(input: EveningInput, baseUrl?: string): LineMessage {
  const problems = input.alerts.filter((a) => a.severity === 'high');
  const problemLines = problems
    .slice(0, MAX_PROBLEMS)
    .map((a) => text(`● ${a.title}${a.detail ? ` - ${a.detail}` : ''}`, { size: 'sm', color: TONES.danger.fg, ...tapTo(urlFor(baseUrl, a.href ?? '/')) }));

  const done = input.process
    .map((p) => ({ label: p.label, count: doneTotal(p.done) }))
    .filter((p) => p.count > 0)
    .sort((a, b) => b.count - a.count);
  const doneLines = done.slice(0, MAX_DONE).map((p) => text(`${p.label} ${p.count}`, { size: 'sm' }));

  const staff = input.staff.filter((s) => s.edits > 0 || s.slips > 0);
  const staffLines = staff.slice(0, MAX_STAFF).map((s) =>
    text(`${s.name}: ${[s.edits > 0 ? `แก้/ยกเลิก ${s.edits} ครั้ง` : '', s.slips > 0 ? `ใบส่งงาน ${s.slips} ใบ` : ''].filter(Boolean).join(' · ')}`, { size: 'sm' }),
  );

  // พรุ่งนี้อย่าลืม: ตามเงินลูกค้าที่ค้างก่อน (เกินกำหนดนานสุด) แล้วเติมเรื่องไม่ด่วนจากรายการแจ้งเตือน
  const reminders = [
    ...input.workingCapital.overdue.customers.slice(0, 2).map((c) => ({ label: `ตามเงิน ${c.customerName} ${baht(c.amount)}`, path: '/accounting/billing' })),
    ...input.alerts.filter((a) => a.severity !== 'high').map((a) => ({ label: `${a.title}${a.detail ? ` - ${a.detail}` : ''}`, path: a.href ?? '/' })),
  ];
  const reminderLines = reminders.slice(0, MAX_REMINDERS).map((r, i) => text(`${i + 1}. ${r.label}`, { size: 'sm', ...tapTo(urlFor(baseUrl, r.path)) }));

  const body = [
    tileRow(
      tile('ใช้จริงวันนี้', baht(input.spend.today.total), 'neutral', undefined, urlFor(baseUrl, '/')),
      tile('ปัญหา', `${problems.length} เรื่อง`, problems.length > 0 ? 'danger' : 'success', undefined, urlFor(baseUrl, '/vehicles?status=problem')),
    ),
    section('ปัญหา', problemLines.length > 0 ? [...problemLines, ...moreLine(problems.length, MAX_PROBLEMS)] : [text('ไม่มีปัญหา', { size: 'sm', color: TONES.success.fg })]),
    section(
      'วันนี้ทำไปแล้ว',
      doneLines.length > 0 ? [...doneLines, ...moreLine(done.length, MAX_DONE)] : [text('วันนี้ยังไม่มีงานที่ทำ', { size: 'sm', color: '#888888' })],
    ),
    ...(staffLines.length > 0
      ? [section('พนักงาน', [...staffLines, ...moreLine(staff.length, MAX_STAFF), text('รายคนมีเฉพาะการแก้ไข/ยกเลิกและใบส่งงาน', { size: 'xxs', color: '#888888' })])]
      : []),
    ...(reminderLines.length > 0 ? [section('พรุ่งนี้อย่าลืม', [...reminderLines, ...moreLine(reminders.length, MAX_REMINDERS)])] : []),
  ];

  return {
    type: 'flex',
    altText: `สรุปเย็น: ใช้จริง ${baht(input.spend.today.total)} · ปัญหา ${problems.length} เรื่อง`,
    contents: bubble('สรุปเย็น', input.today, body, baseUrl),
  };
}
