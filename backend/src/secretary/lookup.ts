// คำสั่ง "ค้นข้อมูล" ของเลขาไลน์ (ผู้ใช้ 2026-11-18 "ข้อมูลเยอะขึ้นแล้ว ... อยากมองอะไรง่ายๆ"): เมนู, งานค้าง, ราคาลูกค้า,
// ต้นทุนต่องาน, ใบเสนอราคา, เอกสาร/ยอดของลูกค้ารายเดียว - ฟังก์ชันล้วน ไม่แตะฐานข้อมูล (อ่านข้อมูลอยู่ใน lookup.service.ts)
// ทุกคำสั่งอ่านอย่างเดียว ไม่ใช้ AI · ตอบเฉพาะเจ้าของ (handleEvents) เพราะมีราคาและต้นทุน
import { baht, text, TONES } from './card-parts.js';
import type { LineMessage, QuickReply } from './line-client.js';

export type LookupCommand =
  | { kind: 'menu' }
  | { kind: 'pending' }
  | { kind: 'jobs' } // สรุปแยกตามประเภทงาน
  | { kind: 'rates'; term: string } // term ว่าง = รายชื่อลูกค้าที่มีตารางราคา
  | { kind: 'cost'; term: string } // term ว่าง = ต้นทุนเฉลี่ยทุกงาน · มี term = ราคาซับของจังหวัดนั้น
  | { kind: 'quotations'; mode: 'latest'; count: number }
  | { kind: 'quotations'; mode: 'numbers'; numbers: string[] }
  | { kind: 'quotations'; mode: 'customer'; term: string }
  | { kind: 'docs'; doc: 'iv' | 'tv'; term: string } // บิล / ใบกำกับ ของลูกค้ารายเดียว
  | { kind: 'customer'; term: string }; // ยอด <ลูกค้า>

export const MAX_LOOKUP_DOCS = 5;
const QT_NUMBER = /QT\d{4}-\d{1,6}(?:-R\d{1,2})?/g;

// ข้อความต้องขึ้นต้นด้วยคำสั่ง (ไม่ใช่แค่มีคำนั้นอยู่) - กันประโยคอื่นที่บังเอิญมีคำว่า "ราคา" / "บิล"
export function parseLookupCommand(input: string): LookupCommand | null {
  const raw = input.trim().replace(/\s+/g, ' ');
  const compact = raw.replace(/\s+/g, '');
  const upper = compact.toUpperCase();
  if (/^(เมนู|menu)$/i.test(compact)) return { kind: 'menu' };
  if (/^งานค้าง/.test(compact)) return { kind: 'pending' };
  // "สรุปเช้า" / "สรุปเย็น" ยังเป็นคำสั่งเดิม
  if (/^สรุป(แต่ละ|ทุก|ราย|ประเภท)*งาน/.test(compact)) return { kind: 'jobs' };

  const rest = (prefix: RegExp) => {
    const m = prefix.exec(raw);
    return m ? raw.slice(m[0].length).trim() : null;
  };

  const qtNumbers = [...new Set(upper.match(QT_NUMBER) ?? [])];
  if (qtNumbers.length && !upper.replace(QT_NUMBER, '').replace(/ใบเสนอราคา|ขอ|ส่ง|[,/]|และ/g, '')) {
    return { kind: 'quotations', mode: 'numbers', numbers: qtNumbers.slice(0, MAX_LOOKUP_DOCS) };
  }
  const quotation = rest(/^ใบเสนอราคา/);
  if (quotation !== null) {
    const latest = /^(?:ที่ออก)?ล่าสุด\s*(\d{1,2})?\s*(?:ใบ|อัน)?$/.exec(quotation);
    if (latest || quotation === '') {
      const count = latest?.[1] ? Number(latest[1]) : 3;
      return { kind: 'quotations', mode: 'latest', count: Math.min(Math.max(count, 1), MAX_LOOKUP_DOCS) };
    }
    return { kind: 'quotations', mode: 'customer', term: quotation };
  }

  const rates = rest(/^ราคา(?:ลูกค้า)?/);
  if (rates !== null) return { kind: 'rates', term: rates };
  const cost = rest(/^ต้นทุน/);
  if (cost !== null) return { kind: 'cost', term: cost };

  const tv = rest(/^ใบกำกับ(?:ภาษี)?/);
  if (tv) return { kind: 'docs', doc: 'tv', term: tv };
  const iv = rest(/^(?:ใบวางบิล|บิล)/);
  if (iv) return { kind: 'docs', doc: 'iv', term: iv };

  // "ยอดใช้จ่าย" เป็นคำสั่งเดิม (spend) - ไม่ใช่ชื่อลูกค้า
  const customer = rest(/^ยอด/);
  if (customer && !customer.startsWith('ใช้')) return { kind: 'customer', term: customer };
  return null;
}

// --- หาลูกค้าจากคำที่พิมพ์ ---------------------------------------------------------
export interface CustomerName {
  id: string;
  name: string;
  company: string | null;
}
export const customerLabel = (c: { name: string; company: string | null }) => c.company?.trim() || c.name;
const norm = (s: string) => s.toLowerCase().replace(/[\s.]/g, '');

// ตรงทั้งชื่อ (ชื่อย่อหรือชื่อบริษัท) ชนะ ไม่งั้นเอาทุกรายที่มีคำนั้นอยู่ในชื่อ
export function matchCustomers<T extends CustomerName>(customers: T[], term: string): T[] {
  const key = norm(term);
  if (!key) return [];
  const exact = customers.filter((c) => norm(c.name) === key || norm(c.company ?? '') === key);
  if (exact.length) return exact;
  return customers.filter((c) => norm(c.name).includes(key) || norm(c.company ?? '').includes(key));
}

export function ambiguousText(term: string, found: CustomerName[]): string {
  if (found.length === 0) return `ไม่พบลูกค้าที่ชื่อมีคำว่า "${term}"`;
  const names = found.slice(0, 10).map((c) => `• ${c.name}${c.company && c.company !== c.name ? ` (${c.company})` : ''}`);
  return [`"${term}" ตรงกับลูกค้า ${found.length} ราย พิมพ์ชื่อให้ชัดขึ้น`, ...names, ...(found.length > names.length ? [`และอีก ${found.length - names.length} ราย`] : [])].join('\n');
}

// --- ข้อความ --------------------------------------------------------------------
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const KIND_LABEL: Record<string, string> = { CAR: 'รถยนต์', MOTO: 'จักรยานยนต์' };

export interface ServiceRateRow {
  label: string;
  vehicleKind: string; // CAR | MOTO | ANY
  ccMin: number | null;
  ccMax: number | null;
  chassisPrefix: string | null;
  registrationProvince: string | null;
  bodyPrefix: string | null;
  amount: number;
  vatInclusive: boolean;
  includesReceipt: boolean;
  kind: string; // BASE | OTHER_PROVINCE | URGENT
}
export interface JobRateLine {
  jobLabel: string; // ชื่องาน + แบบ เช่น "งานโอน (โอนตรวจรถ)"
  vehicleClass: string;
  label: string;
  amount: number;
  includesReceipt: boolean;
}
export interface CustomerTerms {
  vat: boolean;
  whtRate: number;
  creditDays: number | null;
  payWeekday: number | null;
  requiresQuotation: boolean;
}

const WEEKDAY = ['', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์'];
const ADDON_LABEL: Record<string, string> = { OTHER_PROVINCE: 'ขอใช้ (จดจังหวัดอื่น)', URGENT: 'ด่วน' };

function rateNotes(r: { vatInclusive?: boolean; includesReceipt: boolean }): string {
  const notes = [r.vatInclusive ? 'รวม VAT แล้ว' : '', r.includesReceipt ? 'เหมารวมใบเสร็จ' : ''].filter(Boolean);
  return notes.length ? ` (${notes.join(', ')})` : '';
}

function serviceRateLine(r: ServiceRateRow): string {
  const cc = r.ccMin !== null || r.ccMax !== null ? `${r.ccMin ?? 0}-${r.ccMax !== null ? `ไม่ถึง ${r.ccMax}` : 'ขึ้นไป'} cc` : '';
  const only = [r.chassisPrefix ? `ตัวถัง ${r.chassisPrefix}…` : '', r.registrationProvince ? `จด${r.registrationProvince}` : '', r.bodyPrefix ? `ประเภท ${r.bodyPrefix}` : ''].filter(Boolean);
  // label คือข้อความบนบิล มักบอกชนิดรถ/CC อยู่แล้ว - เงื่อนไขจับคู่ต่อท้ายในวงเล็บเหลี่ยมเฉพาะที่ label ไม่ได้บอก
  const extra = [r.label.includes('cc') || !cc ? '' : cc, ...only].filter(Boolean);
  return `• ${r.label || KIND_LABEL[r.vehicleKind] || 'ทุกชนิดรถ'}${extra.length ? ` [${extra.join(' · ')}]` : ''}: ${money(r.amount)}${rateNotes(r)}`;
}

export function ratesText(customerName: string, service: ServiceRateRow[], jobs: JobRateLine[], terms: CustomerTerms): string {
  const lines = [`ราคา ${customerName}`];
  const base = service.filter((r) => r.kind === 'BASE');
  const addons = service.filter((r) => r.kind !== 'BASE');
  if (base.length) lines.push('', 'จดทะเบียนรถใหม่ (ค่าดำเนินการ)', ...base.map(serviceRateLine));
  if (addons.length) lines.push('', 'ค่าเพิ่ม', ...addons.map((r) => `• ${r.label || ADDON_LABEL[r.kind] || r.kind}: +${money(r.amount)}${rateNotes(r)}`));
  if (jobs.length) {
    lines.push('', 'งานอื่นๆ (ค่าบริการ)');
    for (const j of jobs) lines.push(`• ${j.jobLabel}${KIND_LABEL[j.vehicleClass] ? ` ${KIND_LABEL[j.vehicleClass]}` : ''}${j.label ? ` ${j.label}` : ''}: ${money(j.amount)}${rateNotes(j)}`);
  }
  if (!service.length && !jobs.length) lines.push('', 'ยังไม่ได้ตั้งตารางราคาของลูกค้ารายนี้');
  const credit = terms.payWeekday ? `จ่ายทุกวัน${WEEKDAY[terms.payWeekday] ?? ''}` : terms.creditDays !== null ? `เครดิต ${terms.creditDays} วัน` : '';
  const conditions = [terms.vat ? 'VAT 7%' : 'ไม่มี VAT', terms.whtRate > 0 ? `หัก ณ ที่จ่าย ${money(terms.whtRate)}%` : 'ไม่หัก ณ ที่จ่าย', credit, terms.requiresQuotation ? 'ต้องมีใบเสนอราคาก่อนวางบิล' : ''];
  lines.push('', `เงื่อนไข: ${conditions.filter(Boolean).join(' · ')}`, 'ราคาก่อน VAT เว้นแต่ระบุไว้');
  return lines.join('\n');
}

// "ราคา" เฉยๆ = รายชื่อลูกค้าที่ตั้งราคาไว้ พร้อมปุ่มกดต่อ (LINE รับปุ่มลัดไม่เกิน 13 ปุ่ม, label ไม่เกิน 20 ตัวอักษร)
export function rateCustomersMessage(names: string[]): LineMessage {
  if (names.length === 0) return { type: 'text', text: 'ยังไม่มีลูกค้ารายไหนตั้งตารางราคา' };
  const quickReply: QuickReply = {
    items: names.slice(0, 13).map((n) => ({ type: 'action' as const, action: { type: 'message' as const, label: n.slice(0, 20), text: `ราคา ${n}` } })),
  };
  return { type: 'text', text: ['ลูกค้าที่ตั้งราคาไว้ (กดปุ่มด้านล่าง หรือพิมพ์ "ราคา <ชื่อ>")', ...names.map((n) => `• ${n}`)].join('\n'), quickReply };
}

// --- ต้นทุน ---------------------------------------------------------------------
export interface CostSample {
  group: string; // หัวข้อ เช่น "จดทะเบียนรถใหม่"
  label: string; // เช่น "รถยนต์ (จดเอง)"
  cost: number;
}
export interface CostRow {
  group: string;
  label: string;
  count: number;
  average: number;
  min: number;
  max: number;
}

export function summarizeCosts(samples: CostSample[]): CostRow[] {
  const map = new Map<string, CostRow & { sum: number }>();
  for (const s of samples) {
    const key = `${s.group}|${s.label}`;
    const row = map.get(key) ?? { group: s.group, label: s.label, count: 0, average: 0, min: s.cost, max: s.cost, sum: 0 };
    row.count += 1;
    row.sum += s.cost;
    row.min = Math.min(row.min, s.cost);
    row.max = Math.max(row.max, s.cost);
    map.set(key, row);
  }
  return [...map.values()].map(({ sum, ...r }) => ({ ...r, average: Math.round((sum / r.count) * 100) / 100 }));
}

export function costText(rows: CostRow[], days: number): string {
  if (rows.length === 0) return `ยังไม่มีงานใน ${days} วันล่าสุดให้คิดต้นทุน`;
  const lines = [`ต้นทุนเฉลี่ยต่องาน (${days} วันล่าสุด)`, 'ต้นทุน = No Bill (ลงขัน/ค่าซับ) + ค่าอากร · ไม่รวมค่าธรรมเนียมตามใบเสร็จที่เก็บลูกค้าเท่าจริง'];
  let group = '';
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group;
      lines.push('', group);
    }
    const range = r.min === r.max ? '' : ` (ต่ำสุด ${money(r.min)} สูงสุด ${money(r.max)})`;
    lines.push(`• ${r.label}: ${money(r.average)} บาท${range} · ${r.count} งาน`);
  }
  lines.push('', 'รายการ Bill / No Bill ของแต่ละงาน: พิมพ์ "ต้นทุน <งาน>" เช่น "ต้นทุน สลับเลข"');
  return lines.join('\n');
}

export interface SupplierRateRow {
  province: string;
  accepts: boolean;
  serviceFee: number | null;
  channelFee: number | null;
  inspectionFee: number | null;
  plateSwapFee: number | null;
  plateSwapNote: string | null;
  note: string | null;
}

export function supplierRateText(term: string, rows: SupplierRateRow[]): string {
  if (rows.length === 0) return `ไม่พบจังหวัดที่มีคำว่า "${term}" ในตารางราคาซับ`;
  const part = (label: string, v: number | null) => `${label} ${v === null ? '?' : money(v)}`;
  return rows
    .slice(0, 8)
    .map((r) => {
      if (!r.accepts) return `${r.province}: ซับไม่รับจด${r.note ? ` (${r.note})` : ''}`;
      const known = [r.serviceFee, r.channelFee, r.inspectionFee].every((v) => v !== null);
      const total = (r.serviceFee ?? 0) + (r.channelFee ?? 0) + (r.inspectionFee ?? 0);
      return [
        `ราคาซับจด${r.province}`,
        `• ${part('ค่าดำเนินการ', r.serviceFee)} · ${part('ค่าช่อง', r.channelFee)} · ${part('นำรถเข้าตรวจ', r.inspectionFee)}`,
        `• รวม ${money(total)} บาท${known ? '' : ' (ยังไม่ครบ มีช่องที่ยังไม่ทราบราคา)'}`,
        ...(r.plateSwapFee !== null || r.plateSwapNote ? [`• สลับป้าย: ${[r.plateSwapFee !== null ? money(r.plateSwapFee) : '', r.plateSwapNote ?? ''].filter(Boolean).join(' ')}`] : []),
        ...(r.note ? [`• หมายเหตุ: ${r.note}`] : []),
      ].join('\n');
    })
    .join('\n\n');
}

// --- งานค้าง --------------------------------------------------------------------
export interface PendingRow {
  key?: string;
  group: 'new' | 'other';
  label: string;
  pending: { car: number | null; moto: number | null; unsplit?: number } | null;
  oldestDays: number | null;
  lateCount: number;
}

export function pendingText(rows: PendingRow[], finance?: { unbilledVehicles: number; unbilledJobs: number; receivableCount: number; receivableAmount: number }): string {
  const line = (r: PendingRow) => {
    const p = r.pending!;
    const parts = [p.car ? `รถยนต์ ${p.car}` : '', p.moto ? `จยย. ${p.moto}` : '', p.unsplit ? `${p.unsplit}` : ''].filter(Boolean).join(' · ');
    const notes = [r.oldestDays !== null ? `นานสุด ${r.oldestDays} วัน` : '', r.lateCount > 0 ? `เกินกำหนด ${r.lateCount}` : ''].filter(Boolean).join(', ');
    return `${r.lateCount > 0 ? '‼' : '•'} ${r.label}: ${parts}${notes ? ` (${notes})` : ''}`;
  };
  const open = rows.filter((r) => r.pending && (r.pending.car ?? 0) + (r.pending.moto ?? 0) + (r.pending.unsplit ?? 0) > 0);
  const lines = ['งานค้างตอนนี้'];
  const fresh = open.filter((r) => r.group === 'new');
  const other = open.filter((r) => r.group === 'other');
  if (fresh.length) lines.push('', 'จดทะเบียนรถใหม่', ...fresh.map(line));
  if (other.length) lines.push('', 'งานอื่นๆ', ...other.map(line));
  if (open.length === 0) lines.push('', 'ไม่มีงานค้างในขั้นตอนไหนเลย');
  if (finance) {
    const money2 = [
      finance.unbilledVehicles + finance.unbilledJobs > 0 ? `• รอวางบิล: รถ ${finance.unbilledVehicles} คัน · งานอื่น ${finance.unbilledJobs} งาน` : '',
      finance.receivableCount > 0 ? `• รอรับเงิน: ${finance.receivableCount} ใบ ${baht(finance.receivableAmount)}` : '',
    ].filter(Boolean);
    if (money2.length) lines.push('', 'การเงิน (รายละเอียดพิมพ์ "การเงินค้าง")', ...money2);
  }
  lines.push('', '‼ = มีรายการเกินกำหนด · รายคันพิมพ์ "รถติดขัด"');
  return lines.join('\n');
}

// --- สรุปแยกตามประเภทงาน (ผู้ใช้ 2026-11-18 "มันมีหลายประเภทงาน ทำสรุปมาในแต่ละงาน") -------------
export type JobKey = 'NEW' | 'TRANSFER' | 'PLATE_SWAP' | 'TAX_RENEWAL' | 'USE_CANCEL' | 'PLATE_COPY' | 'MOVE_OUT';
type Kind = 'car' | 'moto';
export interface JobSample extends CostSample {
  type: JobKey;
  kind: Kind;
  date: string; // วันที่ยื่น YYYY-MM-DD
}
export interface JobPrice {
  type: JobKey;
  kind: Kind;
  amount: number; // ค่าบริการก่อน VAT ที่วางบิลจริง
}

// stages = key ของแถวในตาราง "งานแต่ละขั้นตอน" ของหน้าภาพรวม (STAGES ใน overview-process.ts) · null = ทุกแถวของกลุ่มรถจดใหม่
export const JOB_SECTIONS: Array<{ type: JobKey; title: string; stages: string[] | null }> = [
  { type: 'NEW', title: 'จดทะเบียนรถใหม่', stages: null },
  { type: 'TRANSFER', title: 'งานโอน', stages: ['transferJob', 'transferInspectSend', 'transferInspectResult'] },
  { type: 'PLATE_SWAP', title: 'สลับเลข', stages: ['plateSwap'] },
  { type: 'TAX_RENEWAL', title: 'ต่อภาษี', stages: ['taxRenewal'] },
  { type: 'USE_CANCEL', title: 'ยกเลิกการใช้รถ', stages: ['useCancel'] },
  { type: 'PLATE_COPY', title: 'คัดแผ่นป้ายทะเบียน', stages: ['plateCopy', 'plateCopyPlate'] },
  { type: 'MOVE_OUT', title: 'ย้ายออก', stages: ['moveOut'] },
];

interface Average {
  average: number;
  count: number;
}
export interface JobSummary {
  title: string;
  submitted: { car: number; moto: number }; // ยื่นเดือนนี้
  pending: Array<{ label: string; count: number; late: boolean }>;
  kinds: Array<{ kind: Kind; cost: Average | null; price: Average | null }>;
}

const averageOf = (values: number[]): Average | null =>
  values.length ? { average: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100, count: values.length } : null;
const pendingCount = (r: PendingRow) => (r.pending ? (r.pending.car ?? 0) + (r.pending.moto ?? 0) + (r.pending.unsplit ?? 0) : 0);

export function buildJobSummaries(input: {
  samples: JobSample[];
  prices: JobPrice[];
  submitted: Array<{ type: JobKey; kind: Kind }>;
  process: PendingRow[];
}): { jobs: JobSummary[]; waitingDelivery: number } {
  const jobs = JOB_SECTIONS.map((section): JobSummary => {
    const rows = input.process.filter((r) => (section.stages ? !!r.key && section.stages.includes(r.key) : r.group === 'new'));
    const count = (kind: Kind) => input.submitted.filter((s) => s.type === section.type && s.kind === kind).length;
    return {
      title: section.title,
      submitted: { car: count('car'), moto: count('moto') },
      pending: rows.filter((r) => pendingCount(r) > 0).map((r) => ({ label: r.label, count: pendingCount(r), late: r.lateCount > 0 })),
      kinds: (['car', 'moto'] as const)
        .map((kind) => ({
          kind,
          cost: averageOf(input.samples.filter((s) => s.type === section.type && s.kind === kind).map((s) => s.cost)),
          price: averageOf(input.prices.filter((p) => p.type === section.type && p.kind === kind).map((p) => p.amount)),
        }))
        .filter((k) => k.cost || k.price),
    };
  });
  // งานอื่นที่ได้ใบเสร็จแล้วรอส่งงานลูกค้า - ภาพรวมนับรวมทุกประเภทงานเป็นแถวเดียว
  const delivery = input.process.find((r) => r.key === 'jobDelivery');
  return { jobs, waitingDelivery: delivery ? pendingCount(delivery) : 0 };
}

const KIND_SHORT: Record<Kind, string> = { car: 'รถยนต์', moto: 'จยย.' };
const SUMMARY_CHUNK = 4500;

// ข้อความเดียวถ้าไม่ยาวเกินที่ LINE รับ ไม่งั้นตัดระหว่างประเภทงาน (ไม่เกิน 5 ข้อความ)
export function jobSummaryTexts(summary: { jobs: JobSummary[]; waitingDelivery: number }, opts: { month: string; days: number }): string[] {
  const blocks = summary.jobs.map((j) => {
    const lines = [`【${j.title}】`];
    const submitted = [j.submitted.car ? `รถยนต์ ${j.submitted.car}` : '', j.submitted.moto ? `จยย. ${j.submitted.moto}` : ''].filter(Boolean).join(' · ');
    lines.push(`ยื่นเดือนนี้: ${submitted || 'ไม่มี'}`);
    lines.push(`ค้าง: ${j.pending.length ? j.pending.map((p) => `${p.label} ${p.count}${p.late ? ' ‼' : ''}`).join(' · ') : 'ไม่มี'}`);
    for (const k of j.kinds) {
      const parts = [
        k.cost ? `ต้นทุน ${money(k.cost.average)} (${k.cost.count} งาน)` : 'ต้นทุน -',
        k.price ? `ค่าบริการ ${money(k.price.average)} (${k.price.count} งาน)` : 'ค่าบริการ -',
        ...(k.cost && k.price ? [`ส่วนต่าง ${money(Math.round((k.price.average - k.cost.average) * 100) / 100)}`] : []),
      ];
      lines.push(`${KIND_SHORT[k.kind]}: ${parts.join(' · ')}`);
    }
    return lines.join('\n');
  });
  const head = `สรุปแต่ละประเภทงาน (เดือน ${opts.month.slice(5, 7)}/${opts.month.slice(0, 4)})`;
  const foot = [
    ...(summary.waitingDelivery > 0 ? [`งานอื่นที่ได้ใบเสร็จแล้ว รอส่งงานลูกค้า: ${summary.waitingDelivery} งาน`, ''] : []),
    `ต้นทุน / ค่าบริการ = เฉลี่ยต่องาน ${opts.days} วันล่าสุด (ต้นทุน = No Bill + ค่าอากร · ค่าบริการ = ก่อน VAT ตามที่วางบิลจริง)`,
    '‼ = มีรายการเกินกำหนด · สลับเลขวางบิลพ่วงกับรถใหม่ จึงไม่มีค่าบริการแยก',
  ].join('\n');
  const chunks: string[] = [];
  let current = head;
  for (const block of [...blocks, foot]) {
    if (current.length + 2 + block.length > SUMMARY_CHUNK) {
      chunks.push(current);
      current = block;
    } else current += `\n\n${block}`;
  }
  chunks.push(current);
  return chunks.slice(0, 5);
}

// --- ใบเสนอราคา -----------------------------------------------------------------
export interface QuotationRow {
  quotationNo: string | null;
  customerName: string;
  kind: string; // JOB | RATE
  status: string;
  title: string;
  issueDate: string;
  validUntil: string;
  feeTotal: number;
  serviceTotal: number;
  goodsTotal: number;
  vatRate: number;
  vatAmount: number;
  whtRate: number;
  whtAmount: number;
  netTotal: number;
  poNumber: string | null;
  invoiceNos: string[];
  url?: string;
}

const QT_STATUS: Record<string, string> = { DRAFT: 'ร่าง', ISSUED: 'รอลูกค้าอนุมัติ', APPROVED: 'อนุมัติแล้ว', REJECTED: 'ลูกค้าไม่อนุมัติ', CANCELLED: 'ยกเลิก', SUPERSEDED: 'ถูกแก้ไขแทนแล้ว' };

export function quotationText(q: QuotationRow, today: string): string {
  const expired = q.status === 'ISSUED' && q.validUntil < today;
  const lines = [
    `ใบเสนอราคา ${q.quotationNo ?? '(ร่าง)'} ${q.customerName}`,
    `วันที่ ${dmy(q.issueDate)} · ยืนราคาถึง ${dmy(q.validUntil)} · ${expired ? 'หมดอายุแล้ว' : (QT_STATUS[q.status] ?? q.status)}`,
    ...(q.title ? [q.title] : []),
    '',
  ];
  if (q.kind === 'RATE') lines.push('ใบเสนออัตราราคา (ไม่มียอดรวม)');
  else {
    if (q.feeTotal > 0) lines.push(`ค่าธรรมเนียม ${money(q.feeTotal)}`);
    if (q.serviceTotal > 0) lines.push(`ค่าบริการ ${money(q.serviceTotal)}`);
    if (q.goodsTotal > 0) lines.push(`ค่าสินค้า ${money(q.goodsTotal)}`);
    if (q.vatAmount > 0) lines.push(`VAT ${money(q.vatRate)}% ${money(q.vatAmount)}`);
    if (q.whtAmount > 0) lines.push(`หัก ณ ที่จ่าย ${money(q.whtRate)}% ${money(q.whtAmount)}`);
    lines.push(`ยอดสุทธิ ${money(q.netTotal)} บาท`);
  }
  if (q.poNumber) lines.push(`PO: ${q.poNumber}`);
  if (q.invoiceNos.length) lines.push(`วางบิลแล้ว: ${q.invoiceNos.join(', ')}`);
  else if (q.status === 'APPROVED' && q.kind === 'JOB') lines.push('ยังไม่ได้วางบิล');
  if (q.url) lines.push('', `เปิดในระบบ: ${q.url}`);
  return lines.join('\n');
}

export function quotationMessages(rows: QuotationRow[], missing: string[], today: string): LineMessage[] {
  const texts = rows.slice(0, MAX_LOOKUP_DOCS).map((q) => quotationText(q, today));
  if (missing.length) {
    const note = `ไม่พบเลขใบเสนอราคา: ${missing.join(', ')}`;
    if (texts.length >= MAX_LOOKUP_DOCS) texts[texts.length - 1] += `\n\n${note}`;
    else texts.push(note);
  }
  if (texts.length === 0) texts.push('ยังไม่มีใบเสนอราคา');
  return texts.map((t): LineMessage => ({ type: 'text', text: t }));
}

// --- ยอดของลูกค้ารายเดียว ---------------------------------------------------------
export interface CustomerSummary {
  customerName: string;
  month: string; // YYYY-MM
  open: Array<{ invoiceNo: string; issueDate: string; dueDate: string | null; netTotal: number }>; // บิลรอรับเงิน เก่าสุดก่อน
  billedMonth: { count: number; amount: number };
  paidMonth: { count: number; amount: number };
  unbilledVehicles: number;
  quotations: Array<{ quotationNo: string | null; status: string; netTotal: number; kind: string }>;
}

const OPEN_MAX = 10;

export function customerSummaryText(s: CustomerSummary, today: string): string {
  const openAmount = s.open.reduce((sum, i) => sum + i.netTotal, 0);
  const late = s.open.filter((i) => i.dueDate && i.dueDate < today);
  const lines = [`ยอด ${s.customerName}`, ''];
  if (s.open.length === 0) lines.push('รอรับเงิน: ไม่มี');
  else {
    lines.push(`รอรับเงิน ${s.open.length} ใบ ${baht(Math.round(openAmount * 100) / 100)}${late.length ? ` (เกินกำหนด ${late.length} ใบ)` : ''}`);
    for (const i of s.open.slice(0, OPEN_MAX)) {
      lines.push(`${i.dueDate && i.dueDate < today ? '‼' : '•'} ${i.invoiceNo} ${baht(i.netTotal)} ออก ${dmy(i.issueDate)}${i.dueDate ? ` ครบ ${dmy(i.dueDate)}` : ''}`);
    }
    if (s.open.length > OPEN_MAX) lines.push(`และอีก ${s.open.length - OPEN_MAX} ใบ`);
  }
  lines.push(
    '',
    `เดือนนี้ (${s.month.slice(5, 7)}/${s.month.slice(0, 4)})`,
    `• วางบิล ${s.billedMonth.count} ใบ ${baht(s.billedMonth.amount)}`,
    `• รับเงินแล้ว ${s.paidMonth.count} ใบ ${baht(s.paidMonth.amount)}`,
  );
  if (s.unbilledVehicles > 0) lines.push('', `ส่งงานแล้วรอวางบิล: รถ ${s.unbilledVehicles} คัน`);
  if (s.quotations.length) {
    lines.push('', 'ใบเสนอราคาที่ยังเปิดอยู่');
    for (const q of s.quotations.slice(0, 5)) lines.push(`• ${q.quotationNo ?? '(ร่าง)'} ${QT_STATUS[q.status] ?? q.status}${q.kind === 'JOB' ? ` ${baht(q.netTotal)}` : ' (อัตราราคา)'}`);
  }
  lines.push('', `ดูต่อ: "บิล ${s.customerName}" · "ใบกำกับ ${s.customerName}" · "ราคา ${s.customerName}"`);
  return lines.join('\n');
}

// --- การ์ดเมนู (ผู้ใช้ 2026-11-18 "อยากมองอะไรง่ายๆ") --------------------------------
// ปุ่มทุกปุ่มส่งคำสั่งเป็นข้อความธรรมดา (เหมือนพิมพ์เอง) จึงไม่ต้องจำสถานะ · label ไม่เกิน 20 ตัวอักษรตามข้อจำกัด LINE
export const MENU_GROUPS: Array<{ title: string; tone: keyof typeof TONES; buttons: Array<{ label: string; text: string }> }> = [
  { title: 'งานค้าง', tone: 'danger', buttons: [{ label: 'งานค้างทั้งหมด', text: 'งานค้าง' }, { label: 'รถติดขัด', text: 'รถติดขัด' }] },
  { title: 'เงิน', tone: 'warning', buttons: [{ label: 'การเงินค้าง', text: 'การเงินค้าง' }, { label: 'ค้างจ่าย', text: 'ค้างจ่าย' }] },
  {
    title: 'เอกสาร',
    tone: 'neutral',
    buttons: [{ label: 'บิลล่าสุด', text: 'บิลล่าสุด' }, { label: 'ใบกำกับล่าสุด', text: 'ใบกำกับล่าสุด' }, { label: 'ใบเสนอราคาล่าสุด', text: 'ใบเสนอราคาล่าสุด' }],
  },
  { title: 'เสนอราคา', tone: 'success', buttons: [{ label: 'ราคาลูกค้า', text: 'ราคา' }, { label: 'ต้นทุนต่องาน', text: 'ต้นทุน' }] },
  { title: 'สรุปประจำวัน', tone: 'neutral', buttons: [{ label: 'สรุปเช้า', text: 'สรุปเช้า' }, { label: 'สรุปเย็น', text: 'สรุปเย็น' }] },
];

export function menuMessage(): LineMessage {
  const group = (g: (typeof MENU_GROUPS)[number]) => ({
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    margin: 'lg',
    contents: [
      text(g.title, { size: 'xs', weight: 'bold', color: TONES[g.tone].fg }),
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: g.buttons.map((b) => ({
          type: 'box',
          layout: 'vertical',
          flex: 1,
          backgroundColor: TONES[g.tone].bg,
          cornerRadius: '8px',
          paddingAll: '10px',
          action: { type: 'message', label: b.label, text: b.text },
          contents: [text(b.label, { size: 'sm', weight: 'bold', color: TONES[g.tone].fg, align: 'center' })],
        })),
      },
    ],
  });
  return {
    type: 'flex',
    altText: 'เมนูเลขา',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: { type: 'box', layout: 'vertical', contents: [text('เมนูเลขา', { weight: 'bold', size: 'md' }), text('กดปุ่ม หรือพิมพ์ชื่อลูกค้าต่อท้าย', { size: 'xs', color: '#888888' })] },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          ...MENU_GROUPS.map(group),
          {
            type: 'box',
            layout: 'vertical',
            margin: 'lg',
            spacing: 'xs',
            contents: [
              text('ค้นตามลูกค้า (พิมพ์เอง)', { size: 'xs', color: '#888888' }),
              text('ยอด SPI · ราคา SPI · บิล SPI', { size: 'sm' }),
              text('ใบกำกับ SPI · ใบเสนอราคา SPI', { size: 'sm' }),
              text('ต้นทุน สลับเลข · ต้นทุน เชียงใหม่', { size: 'sm' }),
            ],
          },
        ],
      },
    },
  };
}
