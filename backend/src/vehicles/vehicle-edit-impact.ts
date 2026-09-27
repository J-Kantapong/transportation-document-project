import { createHash } from 'node:crypto';
import { vehicleKindOf, type VehicleKind } from '../auth/vehicle-scope.js';

// แก้ข้อมูลรถหลังขั้นตอนถัดไปใช้ข้อมูลเดิมไปแล้ว (ผู้ใช้ 2026-09-27): เตือนอย่างเดียว ไม่คิดใหม่ให้อัตโนมัติ
// PATCH /api/vehicles/:id ตอบ 409 { needsConfirm, affected, taxPreview? } จนกว่าผู้ใช้จะกดยืนยัน (confirm: true)
// รายการยื่นที่รอใบเสร็จ = ชี้ให้ไปยกเลิกรายการยื่นแล้วยื่นใหม่ที่หน้า "ดูข้อมูลที่ยื่นแล้ว" (ไม่แก้ราคารายการเดียว - ผู้ใช้ 2026-09-25)

// ช่องที่ขั้นตอนถัดไปใช้คำนวณ/จัดกลุ่ม/พิมพ์ - owner = เฉพาะส่วนที่มีผลกับภาษี (ประเภทเจ้าของ/เช่าซื้อ/ผู้เช่าซื้อ)
// ownerName = ชื่อผู้ถือกรรมสิทธิ์/ผู้ครอบครอง (ไม่มีผลกับภาษี แต่ใบส่งงานอ่านชื่อตอนพิมพ์ - ดู ownerNameChanged)
export type StepField =
  | 'registrationProvince'
  | 'ownerProvince'
  | 'body'
  | 'brandId'
  | 'fuel'
  | 'cc'
  | 'weight'
  | 'owner'
  | 'ownerName'
  | 'customerId';

export const STEP_FIELD_LABELS: Record<StepField, string> = {
  registrationProvince: 'จังหวัดที่จดทะเบียน',
  ownerProvince: 'จังหวัดเจ้าของรถ',
  body: 'ประเภทรถ',
  brandId: 'ยี่ห้อ',
  fuel: 'ประเภทเชื้อเพลิง',
  cc: 'ขนาด CC',
  weight: 'น้ำหนักรถ',
  owner: 'ประเภทเจ้าของรถ/ไฟแนนซ์',
  ownerName: 'ชื่อเจ้าของรถ',
  customerId: 'ลูกค้า',
};

export type AffectedStepKey = 'transfer' | 'inspection' | 'submission' | 'delivery' | 'billing';

// ขั้นตอน -> ช่องที่ขั้นตอนนั้นใช้
// แจ้งย้าย/ตัดบัญชี: สถานะมาจากจังหวัดที่จดทะเบียน ค่าใช้จ่ายมาจากตาราง FeeDeregistration/FeeRelocate (ประเภทรถ + ยี่ห้อ)
// ตรวจรถ: ค่าตรวจจากตาราง FeeInspectionBangkok/FeeInspectionProvince (จังหวัด + ประเภทรถ + ยี่ห้อ)
// ยื่นเอกสาร: ค่าธรรมเนียม (ประเภทรถ + จังหวัดทั้งสอง) ภาษี (ประเภทรถ/เชื้อเพลิง/CC/น้ำหนัก/เจ้าของ) เจ้าของงานในใบส่งงาน (ลูกค้า)
//   และช่องที่ใบส่งงานอ่านตอนพิมพ์ (รถยนต์ = ยี่ห้อ, จักรยานยนต์ = ชื่อเจ้าของ - JOB_SHEET_FIELD)
// ส่งงาน: ใบส่งงานออกในชื่อลูกค้า และอ่านชื่อเจ้าของตอนพิมพ์ (ยี่ห้อเป็น snapshot ใน DeliverySlipItem ไม่นับ)
// วางบิล: ใบวางบิลออกในชื่อลูกค้า
const STEP_FIELDS: Record<AffectedStepKey, StepField[]> = {
  transfer: ['registrationProvince', 'body', 'brandId'],
  inspection: ['registrationProvince', 'body', 'brandId'],
  submission: ['registrationProvince', 'ownerProvince', 'body', 'brandId', 'fuel', 'cc', 'weight', 'owner', 'ownerName', 'customerId'],
  delivery: ['customerId', 'ownerName'],
  billing: ['customerId'],
};

// ใบส่งงานยื่นเอกสาร (frontend job-sheet-print.ts) อ่านจากข้อมูลรถตอนพิมพ์: แบบรถยนต์พิมพ์ยี่ห้อ แบบจักรยานยนต์พิมพ์ชื่อเจ้าของ
// (ผู้ใช้ 2026-09-27 รอบตรวจ) - แก้ช่องนั้นหลังยื่น = พิมพ์ใหม่ไม่ตรงกับใบที่ยื่นไปแล้ว ช่องที่ไม่ได้พิมพ์ในแบบของรถคันนั้นไม่เตือน
const JOB_SHEET_FIELD: Record<VehicleKind, StepField> = { car: 'brandId', moto: 'ownerName' };
// ช่องของขั้นยื่นเอกสารที่ไม่มีผลกับค่าธรรมเนียม/ภาษี - เปลี่ยนแค่ช่องเหล่านี้ไม่ต้องไปยกเลิกแล้วยื่นใหม่
const UNPRICED_SUBMISSION_FIELDS: StepField[] = ['customerId', 'brandId', 'ownerName'];

// ช่องที่ทำให้ภาษีในรายการยื่นเปลี่ยน - เปลี่ยนตอนรายการยังรอใบเสร็จ = แนบภาษีเดิม/ภาษีตามข้อมูลใหม่ไปในคำเตือน
export const TAX_FIELDS: StepField[] = ['body', 'fuel', 'cc', 'weight', 'owner'];

export interface AffectedStep {
  step: AffectedStepKey;
  label: string;
  fields: string[]; // ชื่อช่องภาษาไทยที่เปลี่ยนและขั้นตอนนี้ใช้
  note: string; // ผลที่เกิด + วิธีแก้ (ถ้ามี)
  // คีย์ของคำเตือนนี้ (ขั้นตอน + ป้าย + ช่อง + คำอธิบาย) - หน้าจอส่งคืนใน confirmedSteps ตอนกดยืนยัน (ดู isImpactConfirmed)
  confirmKey: string;
  // เฉพาะ step 'submission': สถานะ + วันที่ยื่นของรายการ - หน้าจอใช้ทำลิงก์ไปยกเลิกแล้วยื่นใหม่ (เฉพาะ PENDING)
  submissionStatus?: string;
  submitDate?: string | null;
  // เฉพาะ step 'submission': รอใบเสร็จ + ช่องที่เปลี่ยนมีผลกับค่าธรรมเนียม/ภาษี = ยกเลิกแล้วยื่นใหม่ช่วยได้
  // (เปลี่ยนแค่ลูกค้า/ยี่ห้อ/ชื่อเจ้าของ = false หน้าจอไม่ชี้ไปยกเลิก - ผู้ใช้ 2026-09-27 รอบตรวจ)
  repriceable?: boolean;
}

// คีย์ของคำเตือน = hash ของทุกอย่างที่ผู้ใช้เห็น (พบ 2026-09-27 รอบตรวจ: เดิมเทียบแค่ชื่อขั้นตอน ถ้าระหว่างนั้นรายการยื่นได้ใบเสร็จ
// คำเตือนเดิมที่บอกให้ยกเลิกแล้วยื่นใหม่ใช้ไม่ได้แล้ว แต่กดยืนยันผ่านได้โดยไม่เตือนใหม่)
export function impactConfirmKey(a: Pick<AffectedStep, 'step' | 'label' | 'fields' | 'note'>): string {
  const digest = createHash('sha256').update(JSON.stringify([a.step, a.label, a.fields, a.note])).digest('hex');
  return `${a.step}:${digest.slice(0, 16)}`;
}

// สถานะขั้นตอนของรถ ณ ตอนแก้ (อ่านหลังล็อกแถวรถ - ดู VehiclesService.updateVehicle)
export interface VehicleStepState {
  transferDone: boolean;
  inspectionSent: boolean; // inspectionSentDate ไม่ว่าง
  inspectionResultPending?: boolean; // ส่งตรวจแล้วแต่ยังไม่มีผล = แก้การส่งตรวจที่หน้าตรวจรถได้ (คิดค่าตรวจใหม่)
  submissionStatus: string | null; // รายการยื่นที่ยัง active ล่าสุด (PENDING / RECEIPT_RECEIVED) ไม่มี = null
  submitDate?: string | null; // วันที่ยื่นของรายการนั้น (YYYY-MM-DD) ใช้บอกว่าไปหาที่วันไหนในหน้า ดูข้อมูลที่ยื่นแล้ว
  delivered: boolean; // มีใบส่งงานที่ยังไม่ยกเลิก หรือ deliveredDate ไม่ว่าง
  billed: boolean; // อยู่ในใบวางบิลที่ยังไม่ VOID
  billingClosed?: boolean; // ปิดงาน - วางบิลนอกระบบแล้ว (Vehicle.billingClosedAt - ผู้ใช้ 2026-09-27)
}

const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export interface VehicleImpactValues {
  registrationProvince: string | null;
  body: string | null;
}

type TransferStatus = 'ตัดบัญชี' | 'แจ้งย้าย';

// กฎเดียวกับ getTransferStatus ใน vehicles.service.ts
function transferStatusOf(province: string | null): TransferStatus | null {
  if (!province) return null;
  return province === 'กรุงเทพมหานคร' ? 'ตัดบัญชี' : 'แจ้งย้าย';
}

function sameNumber(a: unknown, b: unknown): boolean {
  const empty = (v: unknown) => v === null || v === undefined || v === '';
  if (empty(a) || empty(b)) return empty(a) && empty(b);
  return Number(String(a)) === Number(String(b));
}

function sameText(a: unknown, b: unknown): boolean {
  const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return text(a) === text(b);
}

// ช่องที่เปลี่ยนจริง (เทียบค่าในฐานข้อมูลกับค่าที่จะบันทึก) - CC/น้ำหนักเทียบเป็นตัวเลข ("1598" = "1598.00")
// เจ้าของรถเทียบแยกไว้แล้ว: ownerChangedForTax (ownerTaxChanged) / ownerNameChangedFlag (ownerNameChanged)
export function changedStepFields(
  before: Record<Exclude<StepField, 'owner' | 'ownerName'>, unknown>,
  after: Record<Exclude<StepField, 'owner' | 'ownerName'>, unknown>,
  ownerChangedForTax: boolean,
  ownerNameChangedFlag = false,
): StepField[] {
  const changed: StepField[] = [];
  for (const field of Object.keys(STEP_FIELD_LABELS) as StepField[]) {
    if (field === 'owner' || field === 'ownerName') {
      if (field === 'owner' ? ownerChangedForTax : ownerNameChangedFlag) changed.push(field);
      continue;
    }
    const same = field === 'cc' || field === 'weight' ? sameNumber(before[field], after[field]) : sameText(before[field], after[field]);
    if (!same) changed.push(field);
  }
  return changed;
}

// เจ้าของรถเปลี่ยนแบบที่มีผลกับภาษี (ประเภทเจ้าของ, ไฟแนนซ์ = นิติบุคคลเช่าซื้อ, ประเภทผู้เช่าซื้อ) - ชื่ออย่างเดียวไม่นับ
export function ownerTaxChanged(
  before: { ownerType: string; isHirePurchaseBusiness: boolean; hirerType: string | null } | null,
  after: { ownerType: string; isHirePurchaseBusiness: boolean; hirerType: string | null },
): boolean {
  if (!before) return true;
  return before.ownerType !== after.ownerType || before.isHirePurchaseBusiness !== after.isHirePurchaseBusiness || before.hirerType !== after.hirerType;
}

// ชื่อเจ้าของรถเปลี่ยน (ผู้ใช้ 2026-09-27 รอบตรวจ): name = ผู้ถือกรรมสิทธิ์ (ไฟแนนซ์ = ชื่อไฟแนนซ์) hirerName = ผู้ครอบครอง
// ไม่มีผลกับภาษี แต่ใบส่งงานยื่นเอกสารแบบจักรยานยนต์ (name) และใบส่งงาน Delivery (hirerName || name) อ่านชื่อตอนพิมพ์
export function ownerNameChanged(
  before: { name: string | null; hirerName: string | null } | null,
  after: { name: string | null; hirerName: string | null },
): boolean {
  const text = (v: string | null) => (v ?? '').trim();
  if (!before) return Boolean(text(after.name) || text(after.hirerName));
  return text(before.name) !== text(after.name) || text(before.hirerName) !== text(after.hirerName);
}

const RECORDS_HINT = 'ถ้าต้องการให้ค่าธรรมเนียม/ภาษีตรงกับข้อมูลใหม่ ให้ไปยกเลิกรายการยื่นแล้วยื่นใหม่ที่หน้า ดูข้อมูลที่ยื่นแล้ว';

// ขั้นตอนที่ทำไปแล้วโดยใช้ช่องที่กำลังแก้ - ว่าง = แก้ได้เลยไม่ต้องเตือน
export function affectedSteps(
  changed: StepField[],
  state: VehicleStepState,
  before: VehicleImpactValues,
  after: VehicleImpactValues,
): AffectedStep[] {
  const touched = (step: AffectedStepKey) => STEP_FIELDS[step].filter((f) => changed.includes(f));
  const labels = (fields: StepField[]) => fields.map((f) => STEP_FIELD_LABELS[f]);
  const submitted = state.submissionStatus !== null;
  const result: Omit<AffectedStep, 'confirmKey'>[] = [];

  const transferFields = state.transferDone ? touched('transfer') : [];
  if (transferFields.length) {
    const from = transferStatusOf(before.registrationProvince);
    const to = transferStatusOf(after.registrationProvince);
    const effect =
      from && to && from !== to
        ? `ขั้นตอนเปลี่ยนจาก${from}เป็น${to} แต่ที่บันทึกไว้ว่าดำเนินการแล้ว (วันที่/ค่าใช้จ่าย) เป็นของ${from}`
        : 'ค่าใช้จ่ายที่บันทึกไว้คิดจากข้อมูลเดิม ระบบไม่คิดใหม่ให้';
    const remedy = submitted
      ? 'ยื่นเอกสารแล้ว แก้ย้อนหลังไม่ได้'
      : state.inspectionSent
        ? 'แก้วันที่/ค่าใช้จ่ายได้ที่หน้าแจ้งย้าย/ตัดบัญชี (✎ แก้) - ส่งตรวจแล้วจึงยกเลิกสถานะไม่ได้'
        : 'แก้หรือยกเลิกสถานะได้ที่หน้าแจ้งย้าย/ตัดบัญชี (✎ แก้)';
    result.push({ step: 'transfer', label: 'แจ้งย้าย/ตัดบัญชี (ดำเนินการแล้ว)', fields: labels(transferFields), note: `${effect} - ${remedy}` });
  }

  const inspectionFields = state.inspectionSent ? touched('inspection') : [];
  if (inspectionFields.length) {
    // ยังรอผล: "แก้การส่งตรวจ" (correctInspectionSent) คิดค่าตรวจจากข้อมูลรถปัจจุบันให้ใหม่ / มีผลแล้ว: ค่าตรวจคงเดิม
    const remedy =
      state.inspectionResultPending && !submitted
        ? ' - ถ้าต้องการให้ค่าตรวจตรงกับข้อมูลใหม่ ใช้ปุ่ม "แก้การส่งตรวจ" ที่หน้าตรวจรถ (ระบบคิดค่าตรวจใหม่ให้)'
        : '';
    result.push({
      step: 'inspection',
      label: state.inspectionResultPending ? 'ตรวจรถ (ส่งตรวจแล้ว รอผล)' : 'ตรวจรถ (ส่งตรวจแล้ว)',
      fields: labels(inspectionFields),
      note: `ค่าตรวจรถที่บันทึกไว้คิดจากข้อมูลเดิม ระบบไม่คิดใหม่ให้${remedy}`,
    });
  }

  // ยี่ห้อ/ชื่อเจ้าของนับเฉพาะเมื่อใบส่งงานของรถคันนี้พิมพ์ช่องนั้น (ประเภทรถก่อนหรือหลังแก้ - เปลี่ยนประเภทมีคำเตือนแยกอยู่แล้ว)
  const sheetKinds = new Set([vehicleKindOf(before.body), vehicleKindOf(after.body)]);
  const printedFields = new Set([...sheetKinds].map((kind) => JOB_SHEET_FIELD[kind]));
  const onSheet = (f: StepField) => !Object.values(JOB_SHEET_FIELD).includes(f) || printedFields.has(f);
  const submissionFields = submitted ? touched('submission').filter(onSheet) : [];
  if (submissionFields.length) {
    const notes: string[] = [];
    const onDate = state.submitDate ? ` (ยื่นวันที่ ${dmy(state.submitDate)})` : '';
    // ลูกค้า/ยี่ห้อ/ชื่อเจ้าของเปลี่ยนอย่างเดียวไม่กระทบค่าธรรมเนียม/ภาษี - ไม่ชี้ให้ยกเลิกแล้วยื่นใหม่
    const pricedFields = submissionFields.filter((f) => !UNPRICED_SUBMISSION_FIELDS.includes(f));
    const repriceable = state.submissionStatus === 'PENDING' && pricedFields.length > 0;
    if (state.submissionStatus === 'PENDING') {
      if (repriceable) notes.push(`ค่าธรรมเนียม/ภาษีในรายการยื่น${onDate}คิดจากข้อมูลเดิม ระบบไม่คิดใหม่ให้ - ${RECORDS_HINT}`);
    } else {
      notes.push(`ได้ใบเสร็จแล้ว (จดทะเบียนแล้ว)${onDate} - ยอดตามใบเสร็จไม่เปลี่ยน และยกเลิกรายการยื่นไม่ได้แล้ว`);
    }
    if (vehicleKindOf(before.body) !== vehicleKindOf(after.body)) {
      notes.push('ประเภทรถเปลี่ยนระหว่างรถยนต์/จักรยานยนต์ - รถจะย้ายไปอยู่คิวและใบส่งงานของอีกประเภท');
    }
    if (submissionFields.some((f) => printedFields.has(f))) notes.push('ใบส่งงานที่พิมพ์ใหม่จะแสดงข้อมูลใหม่ ไม่ตรงกับใบที่ยื่นไปแล้ว');
    if (submissionFields.includes('customerId')) notes.push('รายการยื่นจะไปอยู่ใต้ลูกค้าใหม่ ใบส่งงานที่พิมพ์ไปแล้วยังเป็นชื่อเดิม');
    result.push({
      step: 'submission',
      label: state.submissionStatus === 'PENDING' ? 'ยื่นเอกสาร (รอใบเสร็จ)' : 'ยื่นเอกสาร (ได้ใบเสร็จแล้ว)',
      fields: labels(submissionFields),
      note: notes.join(' · '),
      submissionStatus: state.submissionStatus ?? undefined,
      submitDate: state.submitDate ?? null,
      repriceable,
    });
  }

  const deliveryFields = state.delivered ? touched('delivery') : [];
  if (deliveryFields.length) {
    const notes: string[] = [];
    if (deliveryFields.includes('customerId')) notes.push('ใบส่งงานที่ออกไปแล้วยังอยู่กับลูกค้าเดิม');
    // ชื่อเจ้าของในใบส่งงานอ่านจากข้อมูลรถตอนพิมพ์ (ไม่ใช่ snapshot) - พิมพ์ซ้ำจะไม่ตรงกับใบที่เซ็นรับไปแล้ว
    if (deliveryFields.includes('ownerName')) notes.push('ใบส่งงานที่พิมพ์ซ้ำจะแสดงชื่อเจ้าของใหม่ ไม่ตรงกับใบที่ลูกค้าเซ็นรับไปแล้ว');
    result.push({
      step: 'delivery',
      label: 'ส่งงาน (Delivery)',
      fields: labels(deliveryFields),
      note: notes.join(' · '),
    });
  }

  const billingFields = state.billed || state.billingClosed ? touched('billing') : [];
  if (billingFields.length) {
    result.push({
      step: 'billing',
      label: state.billed ? 'วางบิล' : 'วางบิล (ปิดงาน - วางบิลนอกระบบ)',
      fields: labels(billingFields),
      note: state.billed
        ? 'ใบวางบิลที่ออกแล้วยังเป็นของลูกค้าเดิม - ถ้าต้องย้ายไปลูกค้าใหม่ ให้ฝ่ายบัญชีเอารถออกจากบิล ("แก้ไขบิล" ติ๊ก "เอาออกจากบิล" รับเงินแล้วให้ "ยกเลิกการรับเงิน" ก่อน) แล้ววางบิลใหม่ในชื่อลูกค้าใหม่'
        : 'ปิดงานไว้ว่าวางบิลนอกระบบแล้วในชื่อลูกค้าเดิม - ระบบไม่ย้ายให้',
    });
  }

  return result.map((a) => ({ ...a, confirmKey: impactConfirmKey(a) }));
}

// ภาษีในรายการยื่นที่รอใบเสร็จเทียบกับภาษีตามข้อมูลใหม่ (preview ไม่บันทึก) - แนบเมื่อช่องที่ใช้คิดภาษีเปลี่ยน
export function needsTaxPreview(changed: StepField[], state: VehicleStepState): boolean {
  return state.submissionStatus === 'PENDING' && changed.some((f) => TAX_FIELDS.includes(f));
}

// ยืนยันแล้วครบทุกคำเตือนหรือยัง - confirmedSteps = confirmKey ของคำเตือนที่ผู้ใช้เห็น ไม่ส่งมา = ยืนยันทั้งหมด (เรียก API ตรง)
// มีขั้นตอนเพิ่ม หรือสถานะ/คำอธิบายของขั้นตอนเดิมเปลี่ยนระหว่างนั้น (เช่น รอใบเสร็จ -> ได้ใบเสร็จแล้ว) = คีย์ไม่ตรง ต้องเตือนใหม่
export function isImpactConfirmed(affected: AffectedStep[], confirm: unknown, confirmedSteps: unknown): boolean {
  if (!affected.length) return true;
  if (confirm !== true) return false;
  if (!Array.isArray(confirmedSteps)) return true;
  return affected.every((a) => confirmedSteps.includes(a.confirmKey));
}
