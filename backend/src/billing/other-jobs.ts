// ดึงงานอื่นๆ เข้าใบวางบิล (ผู้ใช้ 2026-10-07) - ฟังก์ชันล้วน ไม่แตะฐานข้อมูล
// งานที่วางบิลได้: งานโอน, ยกเลิกการใช้รถ, คัดแผ่นป้ายทะเบียน, ย้ายออก (ยื่น -> รับใบเสร็จกลับ) และต่อภาษี
// งานหนึ่งงาน = ค่าธรรมเนียมราชการ (FEE: เงินทดรองจ่าย ไม่มี VAT ไม่หัก ณ ที่จ่าย) + ค่าบริการ (SERVICE: VAT + หัก ณ ที่จ่าย)
// ค่าบริการมาจากตารางราคาของลูกค้าแต่ละราย (JobFeeRate - ผู้ใช้: "ราคาแต่ละเจ้าไม่เท่ากัน") บัญชีแก้ได้ก่อนออกบิล
// ค่าอากรไม่ขึ้นบิลเป็นบรรทัดแยก (ผู้ใช้ไม่ได้สั่ง) นับเป็นต้นทุนของบรรทัดค่าบริการ เหมือนที่ใช้คิดกำไร: ต้นทุน = No Bill + ค่าอากร

import { round2 } from './billing-calculator.js';

export const JOB_TYPES = ['TRANSFER', 'USE_CANCEL', 'PLATE_COPY', 'MOVE_OUT', 'TAX_RENEWAL'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const isJobType = (v: unknown): v is JobType => (JOB_TYPES as readonly unknown[]).includes(v);

export const JOB_LABEL: Record<JobType, string> = {
  TRANSFER: 'งานโอน',
  USE_CANCEL: 'ยกเลิกการใช้รถ',
  PLATE_COPY: 'คัดแผ่นป้ายทะเบียน',
  MOVE_OUT: 'ย้ายออก',
  TAX_RENEWAL: 'ต่อภาษี',
};

// ชื่อตาราง - ใช้ล็อกแถว (SELECT ... FOR UPDATE) เท่านั้น มาจากรายการนี้เสมอ ไม่รับจากผู้ใช้
export const JOB_TABLE: Record<JobType, string> = {
  TRANSFER: 'VehicleTransfer',
  USE_CANCEL: 'VehicleUseCancellation',
  PLATE_COPY: 'PlateCopy',
  MOVE_OUT: 'VehicleMoveOut',
  TAX_RENEWAL: 'TaxRenewal',
};

export const JOB_RATE_VEHICLE_CLASSES = ['CAR', 'MOTO', 'ANY'] as const;
// งานโอน: ราคาแยกตามแบบได้ (โอนตามผู้ถือกรรมสิทธิ์ / โอนตรวจรถ) ว่าง = ทุกแบบ
export const TRANSFER_VARIANTS = ['OWNER', 'INSPECTION'] as const;

export interface JobRateRow {
  id: string;
  jobType: string;
  vehicleClass: string; // CAR | MOTO | ANY
  variant: string | null;
  label: string;
  amount: number;
  sortOrder: number;
}

// แถวราคาแรก (เรียงตาม sortOrder) ที่ประเภทงาน ชนิดรถ และแบบตรงกับงาน - ไม่เจอ = null (ให้บัญชีกรอกเอง ดีกว่าเดาราคาผิด)
export function matchJobRate(rates: JobRateRow[], job: { jobType: JobType; vehicleClass: 'CAR' | 'MOTO'; variant: string | null }): JobRateRow | null {
  const sorted = [...rates].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const r of sorted) {
    if (r.jobType !== job.jobType) continue;
    if (r.vehicleClass !== 'ANY' && r.vehicleClass !== job.vehicleClass) continue;
    if (r.variant && r.variant !== job.variant) continue;
    return r;
  }
  return null;
}

// งานที่พร้อมวางบิลหนึ่งงาน (ข้อมูลที่หน้าจอแสดง + ใช้สร้างบรรทัดบิล)
export interface BillableJob {
  type: JobType;
  id: string;
  customerId: string;
  vehicleClass: 'CAR' | 'MOTO';
  variant: string | null;
  chassis: string;
  plateText: string;
  brand: string | null; // ต่อภาษีไม่มียี่ห้อ ใช้ประเภทรถแทน
  ownerName: string | null;
  doneDate: string; // วันที่รับใบเสร็จกลับ (ต่อภาษี = วันที่คืนเอกสาร)
  receiptNo: string | null;
  receiptAmount: number | null; // ยอดบนใบเสร็จจริง (ต่อภาษีไม่มี)
  billTotal: number; // ยอด Bill ที่ระบบคิดไว้ตอนยื่น
  noBillTotal: number;
  dutyAmount: number;
}

// ค่าธรรมเนียมราชการของงาน = ยอดบนใบเสร็จจริง ไม่มี (ยังไม่ได้อ่าน/กรอก) ใช้ยอด Bill ที่คิดไว้ตอนยื่นแทน และบอกหน้าจอให้ตรวจ
// ต่อภาษีไม่มียอดใบเสร็จ - ยอดภาษีที่คำนวณและบันทึกตอนชำระ (billTotal) คือยอดที่จ่ายจริง
export type FeeSource = 'RECEIPT' | 'ESTIMATE' | 'TAX';
export function feeOf(job: Pick<BillableJob, 'type' | 'receiptAmount' | 'billTotal'>): { amount: number; source: FeeSource } {
  if (job.type === 'TAX_RENEWAL') return { amount: round2(job.billTotal), source: 'TAX' };
  return job.receiptAmount !== null ? { amount: round2(job.receiptAmount), source: 'RECEIPT' } : { amount: round2(job.billTotal), source: 'ESTIMATE' };
}

// snapshot ของงานที่เก็บไว้บนทั้ง 2 บรรทัดของงาน (InvoiceItem.sourceSnapshot) - ใบแนบพิมพ์จากตรงนี้ ไม่อ่านงานสดอีก
// (type alias ไม่ใช่ interface เพื่อให้ Prisma รับเป็น InputJsonObject ได้)
export type JobSnapshot = {
  chassis: string;
  plateText: string;
  brand: string | null;
  ownerName: string | null;
  receiptNo: string | null;
  doneDate: string;
  vehicleClass: 'CAR' | 'MOTO';
  variant: string | null;
  serviceLabel: string;
};

export interface JobItem {
  kind: 'FEE' | 'SERVICE';
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  cost: number | null;
  sortOrder: number;
  sourceType: JobType;
  sourceId: string;
  sourceSnapshot: JobSnapshot;
}

const target = (job: Pick<BillableJob, 'plateText' | 'chassis'>) => job.plateText || job.chassis;

// บรรทัดบิลของงานหนึ่งงาน: FEE (ถ้ามียอด) + SERVICE (ถ้าคิดค่าบริการ > 0) - ทั้งคู่ผูก sourceType/sourceId เดียวกัน
// ต้นทุนของค่าบริการ = No Bill + ค่าอากร (ผู้ใช้ 2026-10-06 ตอนวิเคราะห์กำไร)
// หน้าบิลแบบ SUMMARY ไม่พิมพ์ description เหล่านี้ (รวมเป็นค่าธรรมเนียมรวม / ค่าบริการรวม) แต่เก็บไว้ให้หน้าแก้บิลและบิลแบบเก่าอ่านได้
export function jobItems(job: BillableJob, serviceFee: number, fee: number, serviceLabel: string, firstSortOrder: number): JobItem[] {
  const items: JobItem[] = [];
  const name = JOB_LABEL[job.type];
  const sourceSnapshot: JobSnapshot = {
    chassis: job.chassis,
    plateText: job.plateText,
    brand: job.brand,
    ownerName: job.ownerName,
    receiptNo: job.receiptNo,
    doneDate: job.doneDate,
    vehicleClass: job.vehicleClass,
    variant: job.variant,
    serviceLabel,
  };
  let order = firstSortOrder;
  if (fee > 0) {
    items.push({
      kind: 'FEE',
      description: `ค่าธรรมเนียม${name} ${target(job)}`,
      quantity: 1,
      unitPrice: round2(fee),
      amount: round2(fee),
      cost: null,
      sortOrder: order++,
      sourceType: job.type,
      sourceId: job.id,
      sourceSnapshot,
    });
  }
  if (serviceFee > 0) {
    items.push({
      kind: 'SERVICE',
      description: `ค่าบริการ${name} ${target(job)}${serviceLabel ? ` ${serviceLabel}` : ''}`.slice(0, 300),
      quantity: 1,
      unitPrice: round2(serviceFee),
      amount: round2(serviceFee),
      cost: round2(job.noBillTotal + job.dutyAmount),
      sortOrder: order++,
      sourceType: job.type,
      sourceId: job.id,
      sourceSnapshot,
    });
  }
  return items;
}

// งานที่หน้าจอเลือกมาออกบิล (ใช้ทั้งบิลงานอื่นอย่างเดียวและบิลรถที่พ่วงงานอื่น)
export interface JobPick {
  type: JobType;
  id: string;
  serviceFee: number;
  serviceLabel: string;
}
