import type { YamahaRelocationSize } from '../generated/prisma/enums.js';

// ใบเสนอราคา (ผู้ใช้ 2026-10-01) - ส่วนคำนวณล้วน ไม่แตะฐานข้อมูล (ทดสอบใน quotation-calc.spec.ts)

export const QUOTATION_KINDS = ['JOB', 'RATE'] as const;
export type QuotationKind = (typeof QUOTATION_KINDS)[number];

// เลขที่ QT{ปี ค.ศ.}-{3 หลัก} เช่น QT2026-001 ชุดเดียวทุกบัญชี · ฉบับแก้ไขต่อท้าย -R1, -R2
export function formatQuotationNo(year: number, number: number): string {
  return `QT${year}-${String(number).padStart(3, '0')}`;
}
export function revisionNo(baseNo: string, revision: number): string {
  return revision > 0 ? `${baseNo}-R${revision}` : baseNo;
}

// ขั้นของใบเสนอราคาที่หน้าจอใช้แบ่งกลุ่ม: หมดอายุ = ออกแล้วยังไม่มีคำตอบและเลยวันยืนราคา · DONE = อนุมัติแล้วและออกบิล/ตั้งราคาแล้ว
export const QUOTATION_STAGES = ['DRAFT', 'WAITING', 'EXPIRED', 'APPROVED', 'DONE', 'REJECTED', 'CANCELLED', 'SUPERSEDED'] as const;
export type QuotationStage = (typeof QUOTATION_STAGES)[number];

export function stageOf(q: { status: string; validUntil: string; hasLiveInvoice: boolean; ratesApplied: boolean }, today: string): QuotationStage {
  if (q.status === 'ISSUED') return q.validUntil < today ? 'EXPIRED' : 'WAITING';
  if (q.status === 'APPROVED') return q.hasLiveInvoice || q.ratesApplied ? 'DONE' : 'APPROVED';
  return q.status as QuotationStage;
}

// ---------- งานแจ้งย้ายยามาฮ่ารายเดือน (ลูกค้า YM) ----------
// ชื่อบรรทัดและลำดับตามที่ผู้ใช้กำหนด (2026-10-01):
//   ค่าธรรมเนียมแจ้งจำหน่ายรถจักรยานยนต์ / ค่าดำเนินการแจ้งจำหน่ายรถจักรยานยนต์ (รถเล็ก)
//   ค่าดำเนินการจัดการเอกสารบัญชีรถจักรยานยนต์ยามาฮ่า (รายเดือน 9,000)
//   ค่าธรรมเนียมแจ้งจำหน่ายรถจักรยานยนต์(ใหญ่) / ค่าดำเนินการแจ้งจำหน่ายรถจักรยานยนต์(ใหญ่)
// ค่าธรรมเนียม = ค่าใบเสร็จกรมขนส่ง 5 บาท/คัน (YAMAHA_RELOCATION_BILL_RATE - ไม่มี VAT ไม่หัก ณ ที่จ่าย)
// ค่าดำเนินการต่อคัน (ผู้ใช้ 2026-09-26/30): รถเล็ก 20 บาท (21 ตั้งแต่ 2027-01, 22 ตั้งแต่ 2028-01) · รถใหญ่ 50 บาท - ราคาตามเดือนของงาน
export const YAMAHA_FEE_TITLE = 'ค่าธรรมเนียมแจ้งจำหน่ายรถจักรยานยนต์';
export const YAMAHA_SERVICE_TITLE = 'ค่าดำเนินการแจ้งจำหน่ายรถจักรยานยนต์';
export const YAMAHA_FEE_PER_VEHICLE = 5;
export const YAMAHA_MONTHLY_FEE = 9000;
export const YAMAHA_MONTHLY_FEE_TITLE = 'ค่าดำเนินการจัดการเอกสารบัญชีรถจักรยานยนต์ยามาฮ่า';

export function yamahaServiceRate(size: YamahaRelocationSize, month: string): number {
  if (size === 'LARGE') return 50;
  if (month >= '2028-01') return 22;
  if (month >= '2027-01') return 21;
  return 20;
}

export const isMonth = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

export interface YamahaCounts {
  SMALL: number;
  LARGE: number;
}

// บรรทัดที่เสนอให้ของเดือน month (YYYY-MM ค.ศ.) - ขนาดที่ไม่มีรถในเดือนนั้นไม่ออกบรรทัด · บรรทัดรายเดือนอยู่ระหว่างรถเล็กกับรถใหญ่
export function yamahaQuoteItems(month: string, counts: YamahaCounts) {
  const label = `${month.slice(5, 7)}/${month.slice(0, 4)}`;
  type Line = { kind: 'FEE' | 'SERVICE'; description: string; quantity: number; unitPrice: number; cost: null };
  const forSize = (size: 'SMALL' | 'LARGE'): Line[] => {
    if (counts[size] <= 0) return [];
    const suffix = size === 'LARGE' ? '(ใหญ่)' : '';
    return [
      { kind: 'FEE', description: `${YAMAHA_FEE_TITLE}${suffix} เดือน ${label}`, quantity: counts[size], unitPrice: YAMAHA_FEE_PER_VEHICLE, cost: null },
      { kind: 'SERVICE', description: `${YAMAHA_SERVICE_TITLE}${suffix} เดือน ${label}`, quantity: counts[size], unitPrice: yamahaServiceRate(size, month), cost: null },
    ];
  };
  const monthly: Line = { kind: 'SERVICE', description: `${YAMAHA_MONTHLY_FEE_TITLE} เดือน ${label}`, quantity: 1, unitPrice: YAMAHA_MONTHLY_FEE, cost: null };
  return [...forSize('SMALL'), monthly, ...forSize('LARGE')];
}
